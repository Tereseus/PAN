// pan-link: PAN's own WireGuard link. See docs/INSTALL-PLAN.md and pan-link/README.md.
//
//	pan-link hub    --data DIR [--port 41720] [--bind ADDR] [--backend URL] [--admin ADDR] [--name NAME] [--endpoint HOST:PORT]... [--open-router-port] [--address-record=false]
//	pan-link code   --data DIR [--name "My Pixel"] [--allow "POST /path"]...  (asks the running hub for a pairing code;
//	                --allow limits the device to those requests, see allow.go)
//	pan-link pair   --data DIR --code "pan://pair?..." [--name NAME] [--bind ADDR]
//	pan-link client --data DIR [--listen 127.0.0.1:7779] [--bind ADDR]
//	pan-link probe  [--port 41720]                           (which port opening the router answers; opens nothing)
//
// The hub's first real run listens on a UDP port, so Windows asks about the firewall.
// PAN Setup adds that rule; nobody else should click it on someone's behalf.
// --open-router-port changes the router's port forwarding, so it is off unless PAN Setup
// turns it on after the person agrees. The mapping is dropped again when the hub stops.
// The hub publishes its addresses on Pkarr's relays, encrypted and signed, once a device
// is paired (record.go), so devices find it after an address change; --address-record=false
// turns that off.
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
	"sync"
	"syscall"
	"time"

	link "dev.pan/link"
	"github.com/tailscale/wireguard-go/conn"
	"tailscale.com/net/netmon"
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

// virtualAdapter reports adapters that only reach virtual machines or containers on this
// computer: Hyper-V's switches and WSL (vEthernet), Docker, VirtualBox, VMware, libvirt,
// LXC. A phone can never reach their addresses, so they only make the pairing code longer.
// desc is the Windows adapter description ("" elsewhere).
func virtualAdapter(name, desc string) bool {
	n := strings.ToLower(name)
	for _, p := range []string{"vethernet", "veth", "docker", "br-", "virbr", "vboxnet", "vmnet", "lxcbr", "lxdbr", "podman", "cni", "flannel"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	both := n + " " + strings.ToLower(desc)
	return strings.Contains(both, "virtualbox") || strings.Contains(both, "vmware") || strings.Contains(both, "hyper-v")
}

// isDefaultRoute reports the adapter that carries the default route.
func isDefaultRoute(name string, index int, def netmon.DefaultRouteDetails) bool {
	return (def.InterfaceIndex != 0 && index == def.InterfaceIndex) || (def.InterfaceName != "" && name == def.InterfaceName)
}

// keepAdapter leaves out virtual adapters, except the one that carries the default route:
// a Hyper-V external switch moves the computer's own home network address onto a
// vEthernet adapter, and that one has to stay. If the default route is unknown, every
// adapter stays, since a missing home address costs far more than an extra one.
func keepAdapter(name, desc string, index int, def netmon.DefaultRouteDetails) bool {
	if !virtualAdapter(name, desc) || def == (netmon.DefaultRouteDetails{}) {
		return true
	}
	return isDefaultRoute(name, index, def)
}

// interfaceAddrs lists the addresses on this computer's network interfaces that are up,
// leaving out virtual machine and container adapters (keepAdapter). The adapter with the
// default route comes first, so its home address leads the pairing code.
func interfaceAddrs() []netip.Addr {
	var first, rest []netip.Addr
	def, _ := netmon.DefaultRoute()
	descs := adapterDescriptions()
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || !keepAdapter(ifc.Name, descs[ifc.Index], ifc.Index, def) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			pfx, err := netip.ParsePrefix(a.String())
			if err != nil {
				continue
			}
			if isDefaultRoute(ifc.Name, ifc.Index, def) {
				first = append(first, pfx.Addr())
			} else {
				rest = append(rest, pfx.Addr())
			}
		}
	}
	return append(first, rest...)
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
	record := fs.Bool("address-record", true, "publish this computer's addresses, encrypted and signed, on Pkarr's relays so paired devices find it after an address change")
	meet := fs.Bool("meet", true, "meet in the middle: learn this computer's outside address from public STUN servers and punch toward devices that are away, so they get in with no open port and no relay")
	var extra, stunServers multi
	fs.Var(&extra, "endpoint", "extra address devices can use (repeatable)")
	fs.Var(&stunServers, "stun", "address-check (STUN) server host:port instead of the built in list (repeatable)")
	fs.Parse(args)
	if *data == "" {
		return fmt.Errorf("--data is required")
	}
	if len(stunServers) > 0 {
		link.STUNServers = stunServers
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
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		h.RememberEndpoints()
		if pm != nil {
			log.Print("stopping: asking the router to drop the forward")
			pm.Close()
		}
		l.Close()
		os.Exit(0)
	}()
	// Each device's last address, so after a restart the hub reaches out at once.
	go func() {
		for range time.Tick(10 * time.Second) {
			if err := h.RememberEndpoints(); err != nil {
				log.Printf("saving device addresses: %v", err)
			}
		}
	}()

	h.Endpoints = func() []string {
		if only.IsValid() {
			return append([]string{netip.AddrPortFrom(only, uint16(listen)).String()}, extra...)
		}
		var public netip.AddrPort
		if pm != nil {
			public, _ = pm.External()
		}
		list := orderEndpoints(interfaceAddrs(), uint16(listen), public, extra)
		if *meet {
			list = withOutside(list, l.Outside())
		}
		return list
	}
	if *meet {
		go meetInTheMiddle(h, l)
	}

	go func() {
		for range time.Tick(30 * time.Second) {
			h.ExpirePending()
			if pm != nil {
				pm.External() // renews the forward before it runs out
			}
		}
	}()
	if *record {
		go publishAddresses(h)
	}
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

// withOutside adds the outside addresses the STUN servers saw to the hub's list, ahead of
// its Tailscale addresses: a device away from home sends its handshakes there once the
// hub has punched toward it (punch.go).
func withOutside(list []string, o link.OutsideAddrs) []string {
	var add []string
	for _, a := range o.Strings() {
		known := false
		for _, e := range list {
			known = known || e == a
		}
		if !known {
			add = append(add, a)
		}
	}
	if len(add) == 0 {
		return list
	}
	at := len(list)
	for i, e := range list {
		if ap, err := netip.ParseAddrPort(e); err == nil && link.IsTailnet(ap.Addr()) {
			at = i
			break
		}
	}
	out := append([]string{}, list[:at]...)
	out = append(out, add...)
	return append(out, list[at:]...)
}

// meetInTheMiddle is the hub's side of punch.go: ask the address-check servers every 20 s
// (which also keeps the outside address alive), and every 2 s punch toward devices that
// are away and look for the ones it lost.
func meetInTheMiddle(h *link.Hub, l *link.Link) {
	h.OnPunch = func(d link.Device, addrs []string) {
		log.Printf("meeting %s (%s) at %s", d.Name, d.ID, strings.Join(addrs, ", "))
	}
	last := ""
	probe := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := l.ProbeOutside(ctx)
		cancel()
		if err != nil && err.Error() != last {
			last = err.Error()
			log.Printf("address check: %v", err)
		}
	}
	probe()
	time.Sleep(2 * time.Second)
	seen := ""
	for i := 0; ; i++ {
		if i%10 == 0 {
			if i > 0 {
				probe()
			}
			o := l.Outside()
			if s := fmt.Sprintf("%v hard=%v", o.Strings(), o.Hard); o.Servers > 0 && s != seen {
				seen = s
				kind := "devices away from home can aim at it"
				if o.Hard && !o.V6.IsValid() {
					kind = "this network shows a different port to every destination and has no IPv6: devices away from home cannot get in directly"
				} else if o.Hard {
					kind = "IPv4 is the hard kind here, so devices away from home get in over IPv6 only"
				}
				log.Printf("outside address %v: %s", o.Strings(), kind)
			}
		}
		h.PunchTick(context.Background())
		time.Sleep(2 * time.Second)
	}
}

// publishAddresses keeps the hub's address record current: soon after the start (the
// router's forward may take a few seconds to show up), then every minute. It publishes
// only when the addresses or the record key changed, or hourly, and logs each change.
func publishAddresses(h *link.Hub) {
	time.Sleep(15 * time.Second)
	lastErr := ""
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		ok, err := h.PublishAddresses(ctx)
		cancel()
		switch {
		case err != nil && err.Error() != lastErr:
			lastErr = err.Error()
			log.Printf("address record: %v", err)
		case ok:
			lastErr = ""
			n, _ := h.PublishedAddresses()
			log.Printf("address record published (%d addresses)", n)
		}
		time.Sleep(time.Minute)
	}
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
	var allow stringList
	fs.Var(&allow, "allow", `limit the device to this request, "METHOD /path" or "METHOD /path/*" (repeat for more; none: no limit)`)
	fs.Parse(args)
	if err := link.CheckAllow(allow); err != nil {
		return err
	}
	st, err := link.LoadOrCreateHubState(filepath.Join(*data, "link.json"), 0)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{"name": *name, "ttl_minutes": *ttl, "allow": []string(allow)})
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
	statePath := filepath.Join(*data, "client.json")
	st, err := link.LoadClientState(statePath)
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
	// One link for as long as the program runs, as on the phone: its handshakes go to every
	// known hub address, so it moves by itself when the network changes, and away from home
	// it meets the hub in the middle (link.Meeter, punch.go).
	l, err := link.Open(context.Background(), st, binds)
	if err != nil {
		return err
	}
	defer l.Close()
	errc := make(chan error, 1)
	go func() { errc <- l.ServeLocalProxy(ln, st.HubIP) }()
	var mu sync.Mutex // guards st
	save := func() {
		if err := st.Save(statePath); err != nil {
			log.Printf("saving the pairing: %v", err)
		}
	}
	m := &link.Meeter{Link: l, Log: func(s string) { log.Print(s) },
		State: func() link.ClientState { mu.Lock(); defer mu.Unlock(); return *st }}
	found := func(addrs []string, seq uint64, added int) {
		mu.Lock()
		st.RecordSeq = seq
		if added > 0 {
			st.Endpoints = addrs
		}
		save()
		mu.Unlock()
		if added > 0 {
			log.Printf("address record: %d addresses, %d new", len(addrs), added)
		}
	}
	log.Printf("link started; PAN is on http://%s as soon as the hub answers", ln.Addr())
	state, words := "", ""
	var lastInfo time.Time
	wait := time.Second
	for {
		select {
		case err := <-errc:
			return err
		case <-time.After(wait):
		}
		wait = 5 * time.Second
		connected := false
		if hs, err := l.LastHandshake(st.HubKey); err == nil && !hs.IsZero() && time.Since(hs) < 3*time.Minute {
			connected = true
		}
		via, _ := l.PeerEndpoint(st.HubKey)
		path := link.PathOf(via)
		now := "not reaching the hub"
		if connected {
			now = fmt.Sprintf("connected to the hub via %s (%s)", via, path)
		}
		if now != state {
			state = now
			log.Print(now)
		}
		if connected {
			words = ""
		} else {
			mu.Lock()
			eps := append([]string(nil), st.Endpoints...)
			mu.Unlock()
			if w := link.AwayWords(false, path, l.Outside(), eps); w != words {
				words = w
				log.Print(w)
			}
		}
		// Keep the address record's keys current (they change when the hub removes a device).
		if connected && time.Since(lastInfo) > 6*time.Hour {
			lastInfo = time.Now()
			mu.Lock()
			cp := *st
			mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			changed, err := link.FetchRecordInfo(ctx, l, &cp)
			cancel()
			if err != nil {
				log.Printf("address record keys: %v", err)
			} else if changed {
				mu.Lock()
				st.RecordKey, st.RecordSecret, st.RecordSeq = cp.RecordKey, cp.RecordSecret, cp.RecordSeq
				save()
				mu.Unlock()
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		m.Tick(ctx, connected, path, found)
		time.AfterFunc(30*time.Second, cancel)
	}
}

// stringList is a flag that can be given more than once.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ", ") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }
