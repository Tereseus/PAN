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
	st      *link.ClientState
	l       *link.Link
	ln      net.Listener
	stop    chan struct{}
	once    sync.Once
	dataDir string

	mu     sync.Mutex // guards st's record fields and endpoints while saving, and lookup
	lookup string     // the last address record lookup, for Status
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
	c := &Conn{st: st, l: l, ln: ln, stop: make(chan struct{}), dataDir: dataDir}
	go l.ServeLocalProxy(ln, st.HubIP)
	go c.watch()
	return c, nil
}

// directRetry is how often a link running over Tailscale checks whether a direct path to
// the hub works again. It lands on Tailscale when the hub calls the phone back that way
// after a restart, or while the direct path was down, and WireGuard keeps any path that
// works. Each check is one handshake, and a direct path that answers wins it (the copies
// for Tailscale addresses go later, link.TailnetDelay).
var directRetry = 2 * time.Minute

// The hub's address record (pan-link's record.go): while connected, the phone keeps the
// record's keys current (they change when the hub removes a device); while the hub can't
// be reached on any saved address, it looks the record up for new ones.
var (
	watchTick   = 15 * time.Second
	infoRetry   = 6 * time.Hour    // how often a connected phone asks the hub for the record keys
	lookupAfter = 2 * time.Minute  // no answer from the hub for this long: look it up
	lookupRetry = 10 * time.Minute // at most one lookup per this long
	Relays      []string           // nil: Pkarr's public relays (tests set their own)
)

// watch runs beside the link: back to a direct path when there is one again, and the
// address record (keys while connected, a lookup when the hub is lost).
func (c *Conn) watch() {
	t := time.NewTicker(min(watchTick, directRetry))
	defer t.Stop()
	start := time.Now()
	var lastDirect, lastInfo, lastLookup time.Time
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
		}
		now := time.Now()
		if now.Sub(lastDirect) >= directRetry {
			lastDirect = now
			if pathOf(c.via()) == "tailscale" && c.hasDirect() {
				c.l.Rehandshake(c.st.HubKey)
			}
		}
		s := c.Status()
		c.mu.Lock()
		hasKeys := c.st.RecordKey != ""
		c.mu.Unlock()
		switch {
		case s.Connected:
			if !hasKeys || now.Sub(lastInfo) >= infoRetry {
				lastInfo = now
				c.fetchRecordInfo()
			}
		case hasKeys && now.Sub(start) >= lookupAfter && now.Sub(lastLookup) >= lookupRetry:
			lastLookup = now
			c.findHub()
		}
	}
}

func (c *Conn) fetchRecordInfo() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c.mu.Lock()
	st := *c.st
	c.mu.Unlock()
	changed, err := link.FetchRecordInfo(ctx, c.l, &st)
	if err != nil || !changed {
		return
	}
	c.mu.Lock()
	c.st.RecordKey, c.st.RecordSecret, c.st.RecordSeq = st.RecordKey, st.RecordSecret, st.RecordSeq
	c.saveLocked()
	c.mu.Unlock()
}

// findHub looks the hub up through its address record and adds any new addresses to
// the link (and the saved pairing).
func (c *Conn) findHub() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c.mu.Lock()
	st := *c.st
	c.mu.Unlock()
	addrs, seq, err := link.FindHub(ctx, &st, Relays, nil)
	if err != nil {
		c.setLookup("failed: " + err.Error())
		return
	}
	n := c.l.AddHubAddresses(ctx, c.st.HubKey, addrs)
	c.mu.Lock()
	c.st.RecordSeq = seq
	if n > 0 {
		c.st.Endpoints = addrs
	}
	c.saveLocked()
	c.lookup = fmt.Sprintf("%d addresses, %d new", len(addrs), n)
	c.mu.Unlock()
}

func (c *Conn) setLookup(s string) {
	c.mu.Lock()
	c.lookup = s
	c.mu.Unlock()
}

// saveLocked writes the pairing back (new record keys or hub addresses). Caller holds mu.
func (c *Conn) saveLocked() {
	if c.dataDir != "" {
		c.st.Save(File(c.dataDir))
	}
}

func (c *Conn) via() string {
	v, _ := c.l.PeerEndpoint(c.st.HubKey)
	return v
}

// hasDirect reports a hub address that isn't Tailscale's (a name counts: it is a home
// address looked up through DNS).
func (c *Conn) hasDirect() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
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
	Lookup         string `json:"lookup,omitempty"`  // the last address record lookup
}

func (c *Conn) Status() Status {
	c.mu.Lock()
	s := Status{DeviceID: c.st.DeviceID, HubName: c.st.HubName, Port: c.Port(), SinceHandshake: -1, Lookup: c.lookup}
	c.mu.Unlock()
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
