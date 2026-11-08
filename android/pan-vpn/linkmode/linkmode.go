// Package linkmode is the phone's side of PAN Link (pan-link, docs/INSTALL-PLAN.md):
// pairing with the text of a pairing QR (pan://pair?...), a plain WireGuard link to the
// hub, and a local port that forwards to PAN on the hub. The app talks to that port the
// same way it talks to the Tailscale proxy port, so the rest of the app doesn't change.
//
// It needs only internet access: no Tailscale account, no Android VPN permission.
package linkmode

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"time"

	link "dev.pan/link"
)

// File is where the pairing lives in the app's data folder. It holds the phone's private
// key, so it must stay in the app's own storage.
func File(dataDir string) string { return filepath.Join(dataDir, "pan-link", "client.json") }

// Paired reports whether this phone has a saved pairing.
func Paired(dataDir string) bool {
	_, err := os.Stat(File(dataDir))
	return err == nil
}

// Pair uses a pairing code and saves the result. It returns the device id the hub gave
// this phone. binds is nil on a phone (normal sockets); tests pass their own.
func Pair(ctx context.Context, dataDir, code, name string, binds link.BindFactory) (string, error) {
	st, err := link.Pair(ctx, code, name, binds)
	if err != nil {
		return "", err
	}
	if err := st.Save(File(dataDir)); err != nil {
		return "", err
	}
	return st.DeviceID, nil
}

// Forget deletes the pairing from this phone. The hub lists the phone until it is
// removed there too.
func Forget(dataDir string) error {
	if err := os.Remove(File(dataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Conn is a running link and its local port.
type Conn struct {
	st   *link.ClientState
	l    *link.Link
	ln   net.Listener
	stop chan struct{}
	once sync.Once
}

// Start brings the link up and opens the local port (127.0.0.1, any free port). It does
// not wait for the hub, since a phone often starts with no network: requests through
// the port reach the hub as soon as any of its addresses works.
func Start(ctx context.Context, dataDir string, binds link.BindFactory) (*Conn, error) {
	st, err := link.LoadClientState(File(dataDir))
	if err != nil {
		return nil, fmt.Errorf("not paired: %w", err)
	}
	l, err := link.Open(ctx, st, binds)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		l.Close()
		return nil, err
	}
	c := &Conn{st: st, l: l, ln: ln, stop: make(chan struct{})}
	go l.ServeLocalProxy(ln, st.HubIP)
	go c.preferDirect()
	return c, nil
}

// directRetry is how often a link running over Tailscale checks whether a direct path to
// the hub works again. It lands on Tailscale when the hub calls the phone back that way
// after a restart, or while the direct path was down, and WireGuard keeps any path that
// works. Each check is one handshake, and a direct path that answers wins it (the copies
// for Tailscale addresses go later, link.TailnetDelay).
var directRetry = 2 * time.Minute

func (c *Conn) preferDirect() {
	t := time.NewTicker(directRetry)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
		}
		if pathOf(c.via()) == "tailscale" && c.hasDirect() {
			c.l.Rehandshake(c.st.HubKey)
		}
	}
}

func (c *Conn) via() string {
	v, _ := c.l.PeerEndpoint(c.st.HubKey)
	return v
}

// hasDirect reports a hub address that isn't Tailscale's (a name counts: it is a home
// address looked up through DNS).
func (c *Conn) hasDirect() bool {
	for _, e := range c.st.Endpoints {
		if ap, err := netip.ParseAddrPort(e); err != nil || !IsTailnet(ap.Addr()) {
			return true
		}
	}
	return false
}

// pathOf says what kind of path a hub address is: "local" (the home network),
// "tailscale" or "internet". Empty for no address.
func pathOf(addr string) string {
	ap, err := netip.ParseAddrPort(addr)
	if err != nil {
		return ""
	}
	ip := ap.Addr().Unmap()
	switch {
	case IsTailnet(ip):
		return "tailscale"
	case ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback():
		return "local"
	default:
		return "internet"
	}
}

// Port is the local port that forwards to PAN on the hub.
func (c *Conn) Port() int { return c.ln.Addr().(*net.TCPAddr).Port }

// NetworkChanged moves the link to whichever hub address works now. The app calls it
// when Android reports a new network. Without it the link still moves, after about 15 s.
func (c *Conn) NetworkChanged() error { return c.l.Rehandshake(c.st.HubKey) }

// Status says how the link is doing, for the app's screens and logs.
type Status struct {
	DeviceID       string `json:"device_id"`
	HubName        string `json:"hub_name,omitempty"`
	Port           int    `json:"port"`
	Via            string `json:"via,omitempty"`     // hub address in use
	Path           string `json:"path,omitempty"`    // "local", "tailscale" or "internet"
	SinceHandshake int64  `json:"since_handshake_s"` // -1 if no handshake yet
	Connected      bool   `json:"connected"`         // a handshake in the last 3 minutes
}

func (c *Conn) Status() Status {
	s := Status{DeviceID: c.st.DeviceID, HubName: c.st.HubName, Port: c.Port(), SinceHandshake: -1}
	s.Via = c.via()
	s.Path = pathOf(s.Via)
	if t, err := c.l.LastHandshake(c.st.HubKey); err == nil && !t.IsZero() {
		age := time.Since(t)
		s.SinceHandshake = int64(age / time.Second)
		s.Connected = age < 3*time.Minute
	}
	return s
}

// Close shuts the local port and the link.
func (c *Conn) Close() {
	c.once.Do(func() { close(c.stop) })
	c.ln.Close()
	c.l.Close()
}
