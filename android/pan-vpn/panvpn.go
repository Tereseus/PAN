// Package panvpn provides Tailscale networking for the PAN Android app.
// Compiled via gomobile into an AAR for Kotlin consumption.
package panvpn

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

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
				// Bidirectional copy
				done := make(chan struct{})
				go func() {
					io.Copy(remote, local)
					done <- struct{}{}
				}()
				io.Copy(local, remote)
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
