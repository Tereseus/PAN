// pan-link: PAN's own WireGuard link. See docs/INSTALL-PLAN.md and pan-link/README.md.
//
//	pan-link hub    --data DIR [--port 41720] [--bind ADDR] [--backend URL] [--admin ADDR] [--name NAME] [--endpoint HOST:PORT]... [--open-router-port]
//	pan-link code   --data DIR [--name "My Pixel"]       (asks the running hub for a pairing code)
//	pan-link pair   --data DIR --code "pan://pair?..." [--name NAME] [--bind ADDR]
//	pan-link client --data DIR [--listen 127.0.0.1:7779] [--bind ADDR]
//	pan-link probe  [--port 41720]                           (which port opening the router answers; opens nothing)
//
// The hub's first real run listens on a UDP port, so Windows asks about the firewall.
// PAN Setup adds that rule; nobody else should click it on someone's behalf.
// --open-router-port changes the router's port forwarding, so it is off unless PAN Setup
// turns it on after the person agrees. The mapping is dropped again when the hub stops.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	link "dev.pan/link"
	"github.com/tailscale/wireguard-go/conn"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("pan-link: ")
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "hub":
		err = runHub(args)
	case "code":
		err = runCode(args)
	case "pair":
		err = runPair(args)
	case "client":
		err = runClient(args)
	case "probe":
		err = runProbe(args)
	default:
		usage()
	}
	if err != nil {
		log.Fatal(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: pan-link hub|code|pair|client|probe [options]   (see the top of main.go)")
	os.Exit(2)
}

// bindFor returns nil (all interfaces) or a bind on one address.
func bindFor(addr string) (func() conn.Bind, error) {
	if addr == "" {
		return nil, nil
	}
	ip, err := netip.ParseAddr(addr)
	if err != nil {
		return nil, fmt.Errorf("--bind: %w", err)
	}
	return func() conn.Bind { return link.NewAddrBind(ip) }, nil
}

// Address kinds, in the order devices try them.
const (
	kindSkip    = iota
	kindHome    // home network IPv4 (192.168.x, 10.x, 172.16-31.x)
	kindIPv6    // global IPv6
	kindPublic4 // a public IPv4 right on this computer (modem in bridge mode, a server)
	kindTailnet // Tailscale (100.64.0.0/10 or fd7a:115c:a1e0::/48): the fallback path
)

var (
	tailnetV4 = netip.MustParsePrefix("100.64.0.0/10")
	tailnetV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

func addrKind(ip netip.Addr) int {
	ip = ip.Unmap()
	switch {
	case !ip.IsValid() || ip.IsLoopback() || ip.IsLinkLocalUnicast():
		return kindSkip
	case tailnetV4.Contains(ip) || tailnetV6.Contains(ip):
		return kindTailnet
	case ip.Is4() && ip.IsPrivate():
		return kindHome
	case ip.Is6() && ip.IsGlobalUnicast() && !ip.IsPrivate():
		return kindIPv6
	case ip.Is4() && ip.IsGlobalUnicast():
		return kindPublic4
	}
	return kindSkip
}

// orderEndpoints puts this computer's addresses in the order devices should try them:
// home network IPv4, global IPv6, a public IPv4 on this computer, the router's public
// address (when the router forwards the port), Tailscale last, then any --endpoint the
// owner added.
func orderEndpoints(addrs []netip.Addr, port uint16, public netip.AddrPort, extra []string) []string {
	byKind := map[int][]string{}
	for _, ip := range addrs {
		if k := addrKind(ip); k != kindSkip {
			byKind[k] = append(byKind[k], netip.AddrPortFrom(ip.Unmap(), port).String())
		}
	}
	out := append(byKind[kindHome], byKind[kindIPv6]...)
	out = append(out, byKind[kindPublic4]...)
	if public.IsValid() {
		out = append(out, public.String())
	}
	out = append(out, byKind[kindTailnet]...)
	return append(out, extra...)
}

// interfaceAddrs lists the addresses on this computer's network interfaces that are up.
func interfaceAddrs() []netip.Addr {
	var out []netip.Addr
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if pfx, err := netip.ParsePrefix(a.String()); err == nil {
				out = append(out, pfx.Addr())
			}
		}
	}
	return out
}

func runHub(args []string) error {
	fs := flag.NewFlagSet("hub", flag.ExitOnError)
	data := fs.String("data", "", "PAN data folder (holds link.json)")
	port := fs.Int("port", 41720, "UDP port")
	bindAddr := fs.String("bind", "", "listen on this address only (default: all)")
	backend := fs.String("backend", "http://127.0.0.1:7777", "PAN on this computer")
	admin := fs.String("admin", "127.0.0.1:7792", "admin API address (this computer only)")
	name := fs.String("name", "", "name shown on the phone when pairing")
	openPort := fs.Bool("open-router-port", false, "ask the home router to forward the UDP port (UPnP, NAT-PMP or PCP); only after the person agreed in PAN Setup")
	var extra multi
	fs.Var(&extra, "endpoint", "extra address devices can use (repeatable)")
	fs.Parse(args)
	if *data == "" {
		return fmt.Errorf("--data is required")
	}
	if *openPort && *bindAddr != "" {
		return fmt.Errorf("--open-router-port needs the hub on all addresses (leave out --bind)")
	}
	ap, err := netip.ParseAddrPort(*admin)
	if err != nil || !ap.Addr().IsLoopback() {
		return fmt.Errorf("--admin must be a 127.0.0.1 or ::1 address")
	}
	statePath := filepath.Join(*data, "link.json")
	st, err := link.LoadOrCreateHubState(statePath, *port)
	if err != nil {
		return err
	}
	if *name != "" && st.Name != *name {
		st.Name = *name
		st.Save(statePath)
	}
	binds, err := bindFor(*bindAddr)
	if err != nil {
		return err
	}
	var bind conn.Bind
	var only netip.Addr
	if binds != nil {
		bind = binds()
		only, _ = netip.ParseAddr(*bindAddr)
	}
	l, err := link.Start(link.Config{PrivateKey: st.PrivateKey, TunnelIP: st.HubIP, ListenPort: st.ListenPort, Bind: bind})
	if err != nil {
		return err
	}
	defer l.Close()
	h, err := link.NewHub(l, *backend, st, statePath)
	if err != nil {
		return err
	}
	h.OnError = func(err error) { log.Print(err) }
	listen, _ := l.ListenPort()

	var pm *link.PortMapper
	if *openPort {
		var last netip.AddrPort
		pm, err = link.NewPortMapper(uint16(listen), quietLog("router: "), func() {
			if ext, ok := pm.External(); ok && ext != last {
				last = ext
				log.Printf("router forwards %s to this computer", ext)
			}
		})
		if err != nil {
			return err
		}
		pm.External() // starts asking the router in the background
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-stop
			log.Print("stopping: asking the router to drop the forward")
			pm.Close()
			l.Close()
			os.Exit(0)
		}()
	}

	h.Endpoints = func() []string {
		if only.IsValid() {
			return append([]string{netip.AddrPortFrom(only, uint16(listen)).String()}, extra...)
		}
		var public netip.AddrPort
		if pm != nil {
			public, _ = pm.External()
		}
		return orderEndpoints(interfaceAddrs(), uint16(listen), public, extra)
	}

	go func() {
		for range time.Tick(30 * time.Second) {
			h.ExpirePending()
			if pm != nil {
				pm.External() // renews the forward before it runs out
			}
		}
	}()
	adminLn, err := net.Listen("tcp", *admin)
	if err != nil {
		return err
	}
	go func() { log.Fatal(h.ServeAdmin(adminLn)) }()
	pub, _ := link.PublicKey(st.PrivateKey)
	log.Printf("hub up: key %s, udp %d, tunnel %s, admin %s, %d devices, reach me on %v",
		pub, listen, st.HubIP, *admin, len(h.Devices()), h.Endpoints())
	return h.Serve()
}

// quietLog passes on the port mapper's own messages but drops its [v1]/[v2] chatter.
func quietLog(prefix string) func(string, ...any) {
	return func(format string, a ...any) {
		if strings.HasPrefix(format, "[v") {
			return
		}
		log.Printf(prefix+format, a...)
	}
}

// runProbe asks the router which port opening protocols it answers. Discovery only:
// a NAT-PMP address request, a PCP announce and a UPnP search. No forward is made.
func runProbe(args []string) error {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	port := fs.Int("port", 41720, "the hub's UDP port")
	secs := fs.Int("seconds", 5, "how long to wait for answers")
	fs.Parse(args)
	pm, err := link.NewPortMapper(uint16(*port), quietLog("router: "), nil)
	if err != nil {
		return err
	}
	defer pm.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*secs)*time.Second)
	defer cancel()
	r, err := pm.Probe(ctx)
	if err != nil {
		return err
	}
	yes := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}
	fmt.Printf("router answers: UPnP %s, NAT-PMP %s, PCP %s (nothing was opened)\n", yes(r.UPnP), yes(r.PMP), yes(r.PCP))
	return nil
}

func runCode(args []string) error {
	fs := flag.NewFlagSet("code", flag.ExitOnError)
	data := fs.String("data", "", "PAN data folder")
	admin := fs.String("admin", "127.0.0.1:7792", "admin API address")
	name := fs.String("name", "", "name for the new device")
	ttl := fs.Int("minutes", 10, "how long the code works")
	fs.Parse(args)
	st, err := link.LoadOrCreateHubState(filepath.Join(*data, "link.json"), 0)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{"name": *name, "ttl_minutes": *ttl})
	req, _ := http.NewRequest("POST", "http://"+*admin+"/admin/pair", bytes.NewReader(body))
	req.Header.Set(link.HeaderSecret, st.Secret)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("is the hub running? %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		URI   string `json:"uri"`
		Error string `json:"error"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&out)
	if out.URI == "" {
		return fmt.Errorf("hub said %d %s", resp.StatusCode, out.Error)
	}
	fmt.Println(out.URI)
	return nil
}

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	data := fs.String("data", "", "folder for client.json")
	code := fs.String("code", "", "the pan://pair?... text from the QR")
	name := fs.String("name", "", "this device's name")
	bindAddr := fs.String("bind", "", "use this local address only")
	fs.Parse(args)
	if *data == "" || *code == "" {
		return fmt.Errorf("--data and --code are required")
	}
	binds, err := bindFor(*bindAddr)
	if err != nil {
		return err
	}
	st, err := link.Pair(context.Background(), *code, *name, binds)
	if err != nil {
		return err
	}
	if err := st.Save(filepath.Join(*data, "client.json")); err != nil {
		return err
	}
	log.Printf("paired as %s (%s)", st.DeviceID, st.Name)
	return nil
}

func runClient(args []string) error {
	fs := flag.NewFlagSet("client", flag.ExitOnError)
	data := fs.String("data", "", "folder with client.json")
	listen := fs.String("listen", "127.0.0.1:7779", "local port apps use to reach PAN")
	bindAddr := fs.String("bind", "", "use this local address only")
	fs.Parse(args)
	st, err := link.LoadClientState(filepath.Join(*data, "client.json"))
	if err != nil {
		return err
	}
	binds, err := bindFor(*bindAddr)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	for {
		l, ep, err := link.Connect(context.Background(), st, binds)
		if err != nil {
			log.Printf("hub not reachable (%v); trying again in 15 s", err)
			time.Sleep(15 * time.Second)
			continue
		}
		log.Printf("connected to the hub via %s; PAN is on http://%s", ep, ln.Addr())
		errc := make(chan error, 1)
		go func() { errc <- l.ServeLocalProxy(ln, st.HubIP) }()
		// Keep checking; reconnect (other addresses too) if the hub stops answering.
		for alive := true; alive; {
			select {
			case err := <-errc:
				l.Close()
				return err
			case <-time.After(30 * time.Second):
				ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
				conn, err := l.Net.DialContext(ctx, "tcp", netip.AddrPortFrom(st.HubIP, link.TunnelPort).String())
				cancel()
				if err != nil {
					log.Printf("lost the hub: %v", err)
					alive = false
					break
				}
				conn.Close()
			}
		}
		ln.Close()
		l.Close()
		if ln, err = net.Listen("tcp", *listen); err != nil {
			return err
		}
	}
}
