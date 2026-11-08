package linkmode

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	link "dev.pan/link"
	"github.com/tailscale/wireguard-go/conn"
)

// fakeTailnet stands in for tsnet: a socket whose only peer has a Tailscale address.
// Packets to tailnetHub go to the real hub on 127.0.0.1, and its answers come back
// from tailnetHub.
type fakeTailnet struct {
	net.PacketConn
	hub, tailnetHub netip.AddrPort
}

func norm(a net.Addr) netip.AddrPort {
	ap, _ := netip.ParseAddrPort(a.String())
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
}

func (f *fakeTailnet) WriteTo(b []byte, to net.Addr) (int, error) {
	if norm(to) != f.tailnetHub {
		return 0, errors.New("no such tailnet peer")
	}
	return f.PacketConn.WriteTo(b, net.UDPAddrFromAddrPort(f.hub))
}

func (f *fakeTailnet) ReadFrom(b []byte) (int, net.Addr, error) {
	n, from, err := f.PacketConn.ReadFrom(b)
	if err == nil && norm(from) == f.hub {
		from = net.UDPAddrFromAddrPort(f.tailnetHub)
	}
	return n, from, err
}

// tailnetOnly sets up a hub that a phone can reach only through Tailscale, the way the
// owner's phone reaches the hub: the pairing code holds just the hub's Tailscale address.
func tailnetOnly(t *testing.T) (h *link.Hub, statePath string, tsHub netip.AddrPort, dial func(up *atomic.Bool) TailnetDialer) {
	t.Helper()
	statePath = filepath.Join(t.TempDir(), "link.json")
	h, _, port := startHub(t, fakePAN(t), statePath, 0)
	hub := netip.AddrPortFrom(loopback, uint16(port))
	tsHub = netip.AddrPortFrom(netip.MustParseAddr("100.64.1.1"), uint16(port))
	dial = func(up *atomic.Bool) TailnetDialer {
		return func(v6 bool) (net.PacketConn, error) {
			if v6 || (up != nil && !up.Load()) {
				return nil, errors.New("tailscale is off")
			}
			pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
			if err != nil {
				return nil, err
			}
			return &fakeTailnet{PacketConn: pc, hub: hub, tailnetHub: tsHub}, nil
		}
	}
	return h, statePath, tsHub, dial
}

func codeFor(t *testing.T, h *link.Hub, endpoints ...string) string {
	t.Helper()
	info, err := h.StartPairing("", 0)
	if err != nil {
		t.Fatal(err)
	}
	info.Endpoints = endpoints
	uri, err := info.URI()
	if err != nil {
		t.Fatal(err)
	}
	return uri
}

// The hub's Tailscale address is the only way in. Pairing and the link go through the
// app's Tailscale, and the link reports that address as the one in use.
func TestLinkThroughTheAppsTailscale(t *testing.T) {
	h, _, tsHub, dial := tailnetOnly(t)
	binds := func() conn.Bind { return TailnetBind(link.NewAddrBind(loopback), dial(nil)) }
	dataDir := t.TempDir()
	id, err := Pair(context.Background(), dataDir, codeFor(t, h, tsHub.String()), "Pixel test", binds)
	if err != nil {
		t.Fatalf("pairing through Tailscale: %v", err)
	}
	c, err := Start(context.Background(), dataDir, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	body, err := get(c.Port(), "/api/v1/auth/me", 6*time.Second)
	if err != nil || body != id+"|Pixel test|/api/v1/auth/me" {
		t.Fatalf("through Tailscale: %q %v", body, err)
	}
	if s := c.Status(); s.Via != tsHub.String() || !s.Connected {
		t.Fatalf("status %+v, want via %s", s, tsHub)
	}
}

// The link often starts before the app's Tailscale is up. Packets meant for Tailscale
// wait for it instead of breaking the link, and requests work once it is up.
func TestTailscaleUpAfterTheLink(t *testing.T) {
	h, _, tsHub, dial := tailnetOnly(t)
	dataDir := t.TempDir()
	pairBinds := func() conn.Bind { return TailnetBind(link.NewAddrBind(loopback), dial(nil)) }
	id, err := Pair(context.Background(), dataDir, codeFor(t, h, tsHub.String()), "Pixel test", pairBinds)
	if err != nil {
		t.Fatal(err)
	}
	var up atomic.Bool
	binds := func() conn.Bind { return TailnetBind(link.NewAddrBind(loopback), dial(&up)) }
	c, err := Start(context.Background(), dataDir, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := get(c.Port(), "/x", 1500*time.Millisecond); err == nil {
		t.Fatal("answer with Tailscale off")
	}
	up.Store(true)
	start := time.Now()
	for {
		if body, err := get(c.Port(), "/again", 1500*time.Millisecond); err == nil && strings.HasPrefix(body, id+"|") {
			break
		}
		if time.Since(start) > 15*time.Second {
			t.Fatal("no answer 15 s after Tailscale came up")
		}
	}
	t.Logf("answers %v after Tailscale came up", time.Since(start).Round(time.Millisecond))
}

func TestIsTailnet(t *testing.T) {
	for s, want := range map[string]bool{
		"100.101.102.103": true, "100.64.0.1": true, "100.128.0.1": false,
		"fd7a:115c:a1e0:1234::1": true, "fd0a:b2e1::1": false, "192.168.50.20": false,
		"::ffff:100.100.1.1": true,
	} {
		if got := IsTailnet(netip.MustParseAddr(s)); got != want {
			t.Errorf("IsTailnet(%s) = %v, want %v", s, got, want)
		}
	}
}
