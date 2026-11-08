// Package panvpn provides Tailscale networking for the PAN Android app.
// Compiled via gomobile into an AAR for Kotlin consumption.
package panvpn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"dev.pan/vpn/linkmode"
	"github.com/tailscale/wireguard-go/conn"
	"github.com/wlynxg/anet"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

var crashLogPath string

func init() {
	// Redirect Go crash output to a file since Android drops stderr
	os.Setenv("GOTRACEBACK", "all")
}

func init() {
	// Android SELinux blocks netlink_route_socket for untrusted apps.
	// Use anet to read interfaces without netlink, then register with
	// Tailscale's netmon so tsnet never touches netlink.
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		ifs, err := anet.Interfaces()
		if err != nil {
			return nil, fmt.Errorf("anet.Interfaces: %w", err)
		}
		ret := make([]netmon.Interface, len(ifs))
		for i := range ifs {
			addrs, err := anet.InterfaceAddrsByInterface(&ifs[i])
			if err != nil {
				return nil, fmt.Errorf("ifs[%d].Addrs: %w", i, err)
			}
			ret[i] = netmon.Interface{
				Interface: &ifs[i],
				AltAddrs:  addrs,
			}
		}
		return ret, nil
	})
}

var (
	mu     sync.Mutex
	server *tsnet.Server
	cancel context.CancelFunc
)

// Status holds the current VPN connection state.
type Status struct {
	Connected bool
	Hostname  string
	IP        string
	Org       string
	Error     string
}

// Start connects to the Tailscale network using the given parameters.
// Must be called from a process with VpnService established (for netlink permissions).
// dataDir: app's filesDir for storing Tailscale state
// hostname: the device name on the tailnet (e.g., "pan-phone")
// authKey: pre-authenticated Tailscale auth key (optional, empty = interactive login)
// Returns a login URL if interactive auth is needed, empty string if auth key was used.
func Start(dataDir, hostname, authKey string) (string, error) {
	mu.Lock()
	defer mu.Unlock()

	if server != nil {
		return "", fmt.Errorf("already running")
	}

	stateDir := filepath.Join(dataDir, "tailscale")
	os.MkdirAll(stateDir, 0700)

	s := &tsnet.Server{
		Dir:      stateDir,
		Hostname: hostname,
		Logf:     log.Printf,
	}

	if authKey != "" {
		s.AuthKey = authKey
	}

	ctx, c := context.WithCancel(context.Background())
	cancel = c

	// Redirect fd 2 (stderr) to a file so Go runtime panic traces are captured
	crashLogPath = filepath.Join(dataDir, "go-crash.log")
	crashFile, ferr := os.OpenFile(crashLogPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if ferr == nil {
		syscall.Dup3(int(crashFile.Fd()), 2, 0)
		log.Printf("panvpn: stderr redirected to %s", crashLogPath)
	}

	// Android has no /tmp — set TMPDIR so logpolicy and others can create temp files
	os.Setenv("TMPDIR", dataDir)
	// Also set HOME and XDG dirs so Go's os.UserCacheDir() and os.UserHomeDir() work
	os.Setenv("HOME", dataDir)
	os.Setenv("XDG_CACHE_HOME", filepath.Join(dataDir, "cache"))
	os.Setenv("XDG_CONFIG_HOME", filepath.Join(dataDir, "config"))
	os.MkdirAll(filepath.Join(dataDir, "cache", "Tailscale"), 0700)
	os.MkdirAll(filepath.Join(dataDir, "config"), 0700)

	log.Printf("panvpn: calling tsnet.Start() stateDir=%s hostname=%s", stateDir, hostname)
	if err := s.Start(); err != nil {
		cancel = nil
		return "", fmt.Errorf("tsnet start failed: %w", err)
	}
	log.Printf("panvpn: tsnet.Start() succeeded")

	server = s

	// If no auth key, poll for the login URL (may take a moment to appear)
	if authKey == "" {
		lc, err := s.LocalClient()
		if err != nil {
			return "", fmt.Errorf("local client: %w", err)
		}

		// Poll up to 15 seconds for auth URL or connected state
		for i := 0; i < 30; i++ {
			st, err := lc.StatusWithoutPeers(ctx)
			if err != nil {
				log.Printf("panvpn: status poll %d error: %v", i, err)
				time.Sleep(500 * time.Millisecond)
				continue
			}
			log.Printf("panvpn: status poll %d: state=%s authURL=%q", i, st.BackendState, st.AuthURL)
			if st.AuthURL != "" {
				return st.AuthURL, nil
			}
			if st.BackendState == "Running" {
				// Already authenticated
				return "", nil
			}
			time.Sleep(500 * time.Millisecond)
		}
		log.Printf("panvpn: no auth URL after polling, returning empty (needs auth key or login)")
	}

	return "", nil
}

// Stop disconnects from the Tailscale network.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()

	if server == nil {
		return fmt.Errorf("not running")
	}

	if cancel != nil {
		cancel()
		cancel = nil
	}

	err := server.Close()
	server = nil
	return err
}

// GetStatus returns the current connection status.
func GetStatus() *Status {
	mu.Lock()
	defer mu.Unlock()

	st := &Status{}

	if server == nil {
		st.Connected = false
		return st
	}

	ctx, c := context.WithTimeout(context.Background(), 5*time.Second)
	defer c()

	lc, err := server.LocalClient()
	if err != nil {
		st.Error = err.Error()
		return st
	}

	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		st.Error = err.Error()
		return st
	}

	st.Connected = status.BackendState == "Running"
	st.Hostname = string(server.Hostname)
	if status.CurrentTailnet != nil {
		st.Org = status.CurrentTailnet.Name
	}

	if len(status.TailscaleIPs) > 0 {
		st.IP = status.TailscaleIPs[0].String()
	}

	return st
}

// ListPeers returns a string with all tailnet peers (hostname:ip:online) for debugging.
func ListPeers() string {
	mu.Lock()
	defer mu.Unlock()

	if server == nil {
		return "server not running"
	}

	ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()

	lc, err := server.LocalClient()
	if err != nil {
		return "localclient error: " + err.Error()
	}

	status, err := lc.Status(ctx)
	if err != nil {
		return "status error: " + err.Error()
	}

	var result []string
	for _, peer := range status.Peer {
		ip := ""
		if len(peer.TailscaleIPs) > 0 {
			ip = peer.TailscaleIPs[0].String()
		}
		online := "offline"
		if peer.Online {
			online = "online"
		}
		result = append(result, fmt.Sprintf("%s=%s(%s)", peer.HostName, ip, online))
	}
	return strings.Join(result, "|")
}

// FindServerIP scans the tailnet for a peer matching the given hostname
// and returns its Tailscale IP. If hostname is empty, returns the first
// peer that isn't this device.
func FindServerIP(peerHostname string) string {
	mu.Lock()
	defer mu.Unlock()

	if server == nil {
		return ""
	}

	ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()

	lc, err := server.LocalClient()
	if err != nil {
		return ""
	}

	status, err := lc.Status(ctx)
	if err != nil {
		return ""
	}

	// Log all peers for debugging
	for _, peer := range status.Peer {
		log.Printf("panvpn: peer: %s ip=%v online=%v", peer.HostName, peer.TailscaleIPs, peer.Online)
	}

	for _, peer := range status.Peer {
		name := strings.ToLower(string(peer.HostName))
		if peerHostname != "" {
			search := strings.ToLower(peerHostname)
			if name == search || strings.Contains(name, search) {
				if peer.Online && len(peer.TailscaleIPs) > 0 {
					log.Printf("panvpn: FindServerIP(%s) matched %s = %s", peerHostname, peer.HostName, peer.TailscaleIPs[0])
					return peer.TailscaleIPs[0].String()
				}
				log.Printf("panvpn: FindServerIP(%s) matched %s but offline/no-ip", peerHostname, peer.HostName)
			}
		}
	}

	// If no specific hostname requested, return first online peer
	if peerHostname == "" {
		for _, peer := range status.Peer {
			if peer.Online && len(peer.TailscaleIPs) > 0 {
				return peer.TailscaleIPs[0].String()
			}
		}
	}

	log.Printf("panvpn: FindServerIP(%s) found nothing", peerHostname)
	return ""
}

// Dial connects to a Tailscale peer by hostname and port.
// Returns a net.Conn that can be used for communication.
// Example: conn, err := Dial("pan-desktop", 7777)
func Dial(peerHostname string, port int) (net.Conn, error) {
	mu.Lock()
	s := server
	mu.Unlock()

	if s == nil {
		return nil, fmt.Errorf("not connected")
	}

	ctx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()

	addr := fmt.Sprintf("%s:%d", peerHostname, port)
	return s.Dial(ctx, "tcp", addr)
}

// DialHTTP makes an HTTP request to a Tailscale peer.
// Returns the response body as a string.
func DialHTTP(peerHostname string, port int, path string) (string, error) {
	mu.Lock()
	s := server
	mu.Unlock()

	if s == nil {
		return "", fmt.Errorf("not connected")
	}

	// Create an HTTP client that dials through tsnet
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return s.Dial(ctx, network, addr)
			},
		},
		Timeout: 15 * time.Second,
	}

	url := fmt.Sprintf("http://%s:%d%s", peerHostname, port, path)
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body := make([]byte, 0, 4096)
	buf := make([]byte, 1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	return string(body), nil
}

var (
	proxyListener net.Listener
	proxyMu       sync.Mutex
)

// StartProxy starts a local TCP proxy on localhost that tunnels all
// connections through tsnet to the given peer host:port.
// Returns the local port number. OkHttp connects to localhost:<port>.
func StartProxy(peerHostname string, peerPort int) (int, error) {
	proxyMu.Lock()
	defer proxyMu.Unlock()

	// Close existing proxy if any
	if proxyListener != nil {
		proxyListener.Close()
		proxyListener = nil
	}

	mu.Lock()
	s := server
	mu.Unlock()
	if s == nil {
		return 0, fmt.Errorf("not connected to tailnet")
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("proxy listen: %w", err)
	}
	proxyListener = ln
	port := ln.Addr().(*net.TCPAddr).Port
	target := fmt.Sprintf("%s:%d", peerHostname, peerPort)

	log.Printf("panvpn: proxy listening on localhost:%d → %s via tailscale", port, target)

	go func() {
		for {
			local, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			go func() {
				defer local.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				dialStart := time.Now()
				remote, err := s.Dial(ctx, "tcp", target)
				dialMs := time.Since(dialStart).Milliseconds()
				if err != nil {
					log.Printf("panvpn: proxy dial %s failed after %dms: %v", target, dialMs, err)
					return
				}
				log.Printf("panvpn: proxy dial %s succeeded in %dms", target, dialMs)
				defer remote.Close()
				// Bidirectional copy. Whichever side finishes first closes the other:
				// the hub drops an idle keep-alive socket after 5 s, and while this kept
				// the phone's side open, OkHttp pooled the dead connection and the next
				// voice turn waited on it (7-10 s stalls, voicebench 2026-11-02).
				done := make(chan struct{})
				go func() {
					io.Copy(remote, local)
					remote.Close()
					done <- struct{}{}
				}()
				io.Copy(local, remote)
				local.Close()
				<-done
			}()
		}
	}()

	return port, nil
}

// StopProxy stops the local proxy.
func StopProxy() {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if proxyListener != nil {
		proxyListener.Close()
		proxyListener = nil
	}
}

// GetProxyPort returns the current proxy port, or 0 if not running.
func GetProxyPort() int {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if proxyListener == nil {
		return 0
	}
	return proxyListener.Addr().(*net.TCPAddr).Port
}

// IsRunning returns true if the VPN connection is active.
func IsRunning() bool {
	mu.Lock()
	defer mu.Unlock()
	return server != nil
}

// ---- PAN Link: plain WireGuard to the hub (pan-link), no Tailscale account ----
//
// The app pairs once with the text of the hub's pairing QR, then LinkStart gives it a
// local port that forwards to PAN on the hub, used exactly like the Tailscale proxy
// port. It needs only internet access, so it works without the VPN permission.
// Packets for the hub's Tailscale address go through this file's tsnet when it runs
// (linkmode.TailnetBind): home Wi-Fi that keeps devices apart, or a home router that
// lets nothing in, leaves that as the only way to the hub.

var (
	linkMu   sync.Mutex
	linkConn *linkmode.Conn
)

// tailnetSocket opens a UDP socket on this phone's Tailscale address through tsnet.
func tailnetSocket(v6 bool) (net.PacketConn, error) {
	mu.Lock()
	s := server
	mu.Unlock()
	if s == nil {
		return nil, fmt.Errorf("tailscale is off")
	}
	ip4, ip6 := s.TailscaleIPs()
	ip, network := ip4, "udp4"
	if v6 {
		ip, network = ip6, "udp6"
	}
	if !ip.IsValid() {
		return nil, fmt.Errorf("tailscale has no address yet")
	}
	return s.ListenPacket(network, netip.AddrPortFrom(ip, 0).String())
}

// linkBinds sends the link's packets through the phone's normal sockets, and through
// tsnet for Tailscale addresses.
func linkBinds() conn.Bind { return linkmode.TailnetBind(conn.NewDefaultBind(), tailnetSocket) }

// LinkPair pairs this phone with a hub using the text of its pairing QR (pan://pair?...)
// and returns the device id the hub gave it. name is shown on the hub (e.g. "Pixel 10").
func LinkPair(dataDir, code, name string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return linkmode.Pair(ctx, dataDir, strings.TrimSpace(code), name, linkBinds)
}

// LinkPaired reports whether this phone has a saved pairing.
func LinkPaired(dataDir string) bool { return linkmode.Paired(dataDir) }

// LinkStart brings the link up and returns the local port that forwards to PAN on the
// hub. It does not wait for the hub. Calling it again returns the running port.
func LinkStart(dataDir string) (int, error) {
	linkMu.Lock()
	defer linkMu.Unlock()
	if linkConn != nil {
		return linkConn.Port(), nil
	}
	c, err := linkmode.Start(context.Background(), dataDir, linkBinds)
	if err != nil {
		return 0, err
	}
	linkConn = c
	log.Printf("panvpn: pan-link up, local port %d", c.Port())
	return c.Port(), nil
}

// LinkNetworkChanged moves the link to whichever hub address works now. Call it when
// Android reports a new default network; without it the link moves after about 15 s.
func LinkNetworkChanged() {
	linkMu.Lock()
	c := linkConn
	linkMu.Unlock()
	if c != nil {
		c.NetworkChanged()
	}
}

// LinkStatus is a JSON object: paired, running, and while running device_id, hub_name,
// port, via (the hub address in use), since_handshake_s and connected.
func LinkStatus(dataDir string) string {
	linkMu.Lock()
	c := linkConn
	linkMu.Unlock()
	out := map[string]any{"paired": linkmode.Paired(dataDir), "running": c != nil}
	if c != nil {
		b, _ := json.Marshal(c.Status())
		json.Unmarshal(b, &out)
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// LinkStop shuts the link and its local port.
func LinkStop() {
	linkMu.Lock()
	defer linkMu.Unlock()
	if linkConn != nil {
		linkConn.Close()
		linkConn = nil
	}
}

// LinkForget stops the link and deletes this phone's pairing.
func LinkForget(dataDir string) error {
	LinkStop()
	return linkmode.Forget(dataDir)
}

// GetCrashLog reads the Go crash log from the last run.
// Returns empty string if no crash log exists.
func GetCrashLog() string {
	if crashLogPath == "" {
		return ""
	}
	data, err := os.ReadFile(crashLogPath)
	if err != nil {
		return ""
	}
	return string(data)
}
