package link

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// A device whose program restarts (an update, a PC's launcher bringing it back) connects
// again at once with the same key, even though the hub still holds the old instance's
// session. (A restart within about 20 ms of the last handshake costs WireGuard's 5 s
// retry: the hub takes it for a replay. No launcher restarts that fast.)
func TestDeviceRestartsQuickly(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	h, _, _ := hubOnPort(t, pan.URL, statePath, 0)
	info, _ := h.StartPairing("PC", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	for i, gap := range []time.Duration{time.Second} {
		l, _, err := Connect(context.Background(), st, phoneBinds)
		if err != nil {
			t.Fatalf("round %d: first connect: %v", i, err)
		}
		if _, err := getWithin(l, "/before", 3*time.Second); err != nil {
			t.Fatalf("round %d: %v", i, err)
		}
		l.Close()
		time.Sleep(gap)
		t0 := time.Now()
		l2, _, err := Connect(context.Background(), st, phoneBinds)
		if err != nil {
			t.Fatalf("round %d: restarted %v after the old one stopped: %v (%v)", i, gap, err, time.Since(t0).Round(time.Millisecond))
		}
		t.Logf("restart %v after: connected in %v", gap, time.Since(t0).Round(time.Millisecond))
		l2.Close()
	}
}

// Like a crash: the old instance dies with a connection to PAN still open.
func TestDeviceRestartsAfterACrash(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	h, _, _ := hubOnPort(t, pan.URL, statePath, 0)
	info, _ := h.StartPairing("PC", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	for i, gap := range []time.Duration{2 * time.Second} {
		l, _, err := Connect(context.Background(), st, phoneBinds)
		if err != nil {
			t.Fatalf("round %d: first connect: %v", i, err)
		}
		// A connection left open, as a crash leaves it.
		c, err := l.Net.DialContext(context.Background(), "tcp", hubURL(DefaultHubIP, "")[len("http://"):])
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte("GET /open HTTP/1.1\r\nHost: x\r\n\r\n"))
		time.Sleep(200 * time.Millisecond)
		l.Close() // no FIN for c: the hub still thinks it is open
		time.Sleep(gap)
		t0 := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		l2, _, err := Connect(ctx, st, phoneBinds)
		cancel()
		if err != nil {
			t.Fatalf("round %d: restarted %v after a crash: %v (%v)", i, gap, err, time.Since(t0).Round(time.Millisecond))
		}
		t.Logf("round %d: restart %v after a crash: connected in %v", i, gap, time.Since(t0).Round(time.Millisecond))
		l2.Close()
	}
}
