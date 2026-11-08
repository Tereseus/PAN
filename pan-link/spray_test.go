package link

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// Away from home the saved addresses start with ones that go nowhere. Pairing and
// connecting try them all at once, so they take about as long as the working address,
// not 6 seconds for each dead one.
func TestConnectTriesAllAddressesAtOnce(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	live := th.hub.Endpoints()[0]

	// A loopback port with nothing on it, and an address a 127.0.0.1 socket can't send to.
	dead, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := dead.LocalAddr().String()
	dead.Close()

	info, _ := th.hub.StartPairing("Pixel", 0)
	info.Endpoints = []string{deadAddr, "192.0.2.1:9", live}
	uri, _ := info.URI()
	start := time.Now()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatalf("pairing with dead addresses first: %v", err)
	}
	pairTook := time.Since(start)

	start = time.Now()
	l, ep, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	took := time.Since(start)
	if ep != live {
		t.Fatalf("connected via %q, want %q", ep, live)
	}
	if pairTook > 4*time.Second || took > 3*time.Second {
		t.Fatalf("too slow: pairing %v, connecting %v", pairTook, took)
	}
	// Data goes only to the address that worked, and flows.
	if body, err := get(t, l, "/after", nil); err != nil || !strings.HasPrefix(body, st.DeviceID) {
		t.Fatalf("after connecting: %q %v", body, err)
	}
	t.Logf("pairing %v, connecting %v, via %s", pairTook.Round(time.Millisecond), took.Round(time.Millisecond), ep)
}

// udpRelay stands in for one network path between a device and the hub (home Wi-Fi,
// mobile data, Tailscale): it forwards UDP through its own ports. Close cuts the path.
type udpRelay struct {
	front *net.UDPConn // the device sends here
	back  *net.UDPConn // connected to the hub
	down  atomic.Bool  // drops everything, like a network that is gone for now
}

func newRelay(t *testing.T, hub string) *udpRelay {
	t.Helper()
	lo := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}
	front, err := net.ListenUDP("udp4", lo)
	if err != nil {
		t.Fatal(err)
	}
	hubAddr, err := net.ResolveUDPAddr("udp4", hub)
	if err != nil {
		t.Fatal(err)
	}
	back, err := net.DialUDP("udp4", lo, hubAddr)
	if err != nil {
		t.Fatal(err)
	}
	r := &udpRelay{front: front, back: back}
	var device atomic.Pointer[net.UDPAddr]
	go func() {
		buf := make([]byte, 65535)
		for {
			n, from, err := front.ReadFromUDP(buf)
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				continue // Windows reports an earlier bounce as a read error
			}
			if r.down.Load() {
				continue
			}
			device.Store(from)
			back.Write(buf[:n])
		}
	}()
	go func() {
		buf := make([]byte, 65535)
		for {
			n, err := back.Read(buf)
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				continue
			}
			if d := device.Load(); d != nil && !r.down.Load() {
				front.WriteToUDP(buf[:n], d)
			}
		}
	}()
	t.Cleanup(r.Close)
	return r
}

func (r *udpRelay) Addr() string { return r.front.LocalAddr().String() }
func (r *udpRelay) Close()       { r.front.Close(); r.back.Close() }

// The path a phone uses dies (it leaves home Wi-Fi). After Rehandshake, which the app
// calls when Android reports a network change, the link is on another path at once.
// With nobody saying anything, WireGuard's own retry finds one within about 15 s.
func TestLinkMovesWhenItsPathDies(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	relays := map[string]*udpRelay{}
	var paths []string
	for i := 0; i < 3; i++ {
		r := newRelay(t, th.hub.Endpoints()[0])
		relays[r.Addr()] = r
		paths = append(paths, r.Addr())
	}
	info, _ := th.hub.StartPairing("Pixel", 0)
	info.Endpoints = paths
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	l, first, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	connected := time.Now()

	// back polls through the link until PAN answers, and says how long that took and
	// which path carries the link now.
	back := func(limit time.Duration) (time.Duration, string) {
		t.Helper()
		start := time.Now()
		for time.Since(start) < limit {
			req, _ := http.NewRequest("GET", hubURL(DefaultHubIP, "/ping"), nil)
			if resp, err := tunnelClient(l, time.Second).Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					ep, _ := l.PeerEndpoint(st.HubKey)
					return time.Since(start), ep
				}
			}
		}
		t.Fatalf("link not back within %v", limit)
		return 0, ""
	}

	// WireGuard sends at most one handshake every 5 s, and Connect just sent one.
	time.Sleep(5500*time.Millisecond - time.Since(connected))
	relays[first].Close()
	if err := l.Rehandshake(st.HubKey); err != nil {
		t.Fatal(err)
	}
	took, second := back(10 * time.Second)
	if second == first {
		t.Fatalf("still on the dead path %s", first)
	}
	t.Logf("path %s cut; after Rehandshake the link moved to %s in %v", first, second, took.Round(time.Millisecond))
	if took > 4*time.Second {
		t.Fatalf("Rehandshake took %v to move the link", took)
	}

	if testing.Short() {
		return
	}
	relays[second].Close()
	took, third := back(30 * time.Second)
	if third == first || third == second {
		t.Fatalf("on a dead path %s", third)
	}
	t.Logf("path %s cut; with no Rehandshake the link moved to %s in %v", second, third, took.Round(time.Millisecond))
}

// The phone has no network for a while (Wi-Fi off, no mobile data), so WireGuard keeps
// sending handshakes into nothing. Then a network comes back on another path. WireGuard
// itself would wait up to 5 s before its next try; Rehandshake must use the new path now.
func TestRehandshakeRightAfterAFailedTry(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	relays := map[string]*udpRelay{}
	var paths []string
	for i := 0; i < 2; i++ {
		r := newRelay(t, th.hub.Endpoints()[0])
		relays[r.Addr()] = r
		paths = append(paths, r.Addr())
	}
	info, _ := th.hub.StartPairing("Pixel", 0)
	info.Endpoints = paths
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	l, first, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	connected := time.Now()
	other := paths[0]
	if other == first {
		other = paths[1]
	}

	// No network at all: the handshake Rehandshake starts goes nowhere.
	time.Sleep(5500*time.Millisecond - time.Since(connected))
	for _, r := range relays {
		r.down.Store(true)
	}
	if err := l.Rehandshake(st.HubKey); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)

	// A network comes up, not the one the link was on (Wi-Fi back, or mobile data).
	relays[other].down.Store(false)
	before, _ := l.LastHandshake(st.HubKey)
	start := time.Now()
	if err := l.Rehandshake(st.HubKey); err != nil {
		t.Fatal(err)
	}
	for {
		if hs, _ := l.LastHandshake(st.HubKey); hs.After(before) {
			break
		}
		if time.Since(start) > 10*time.Second {
			t.Fatal("no handshake within 10 s")
		}
		time.Sleep(5 * time.Millisecond)
	}
	took := time.Since(start)
	ep, _ := l.PeerEndpoint(st.HubKey)
	t.Logf("network back on %s 1 s after a failed try: handshake done in %v, link via %s", other, took.Round(time.Millisecond), ep)
	if ep != other {
		t.Fatalf("link on %s, want %s", ep, other)
	}
	if took > time.Second {
		t.Fatalf("Rehandshake waited %v, as if for WireGuard's 5 s limit", took)
	}
	if body, err := get(t, l, "/back", nil); err != nil || !strings.HasPrefix(body, st.DeviceID) {
		t.Fatalf("after the move: %q %v", body, err)
	}
}

type stubBind struct{ fn conn.ReceiveFunc }

func (s stubBind) Open(uint16) ([]conn.ReceiveFunc, uint16, error) {
	return []conn.ReceiveFunc{s.fn}, 1, nil
}
func (stubBind) Close() error                                { return nil }
func (stubBind) SetMark(uint32) error                        { return nil }
func (stubBind) Send([][]byte, conn.Endpoint, int) error     { return nil }
func (stubBind) ParseEndpoint(string) (conn.Endpoint, error) { return nil, errors.New("stub") }
func (stubBind) BatchSize() int                              { return 1 }

// A "port unreachable" bounce must not stop the link from reading; real errors still pass.
func TestBounceErrorsDoNotStopTheLink(t *testing.T) {
	bounce := syscall.ECONNREFUSED
	if runtime.GOOS == "windows" {
		bounce = syscall.Errno(10054) // WSAECONNRESET
	}
	calls := 0
	fn := func(p [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		calls++
		if calls == 1 {
			return 0, &net.OpError{Op: "read", Net: "udp", Err: os.NewSyscallError("recvfrom", bounce)}
		}
		if calls == 2 {
			sizes[0] = 3
			return 1, nil
		}
		return 0, net.ErrClosed
	}
	fns, _, err := (&quietBind{Bind: stubBind{fn}}).Open(0)
	if err != nil {
		t.Fatal(err)
	}
	bufs, sizes, eps := [][]byte{make([]byte, 8)}, []int{0}, []conn.Endpoint{nil}
	if n, err := fns[0](bufs, sizes, eps); err != nil || n != 1 || sizes[0] != 3 || calls != 2 {
		t.Fatalf("after a bounce: n=%d err=%v calls=%d", n, err, calls)
	}
	if _, err := fns[0](bufs, sizes, eps); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("a closed socket must still end the read loop, got %v", err)
	}
}

func TestResolveEndpoints(t *testing.T) {
	got := resolveEndpoints(context.Background(), []string{
		"127.0.0.1:1", "127.0.0.1:1", "[::ffff:10.0.0.1]:2", "not an address", "localhost:3",
	})
	if len(got) < 3 || got[0] != "127.0.0.1:1" || got[1] != "10.0.0.1:2" {
		t.Fatalf("got %v", got)
	}
	if !slices.ContainsFunc(got[2:], func(s string) bool { return strings.HasSuffix(s, ":3") }) {
		t.Fatalf("localhost was not looked up: %v", got)
	}
	if n := strings.Count(strings.Join(got, " "), "127.0.0.1:1"); n != 1 {
		t.Fatalf("repeat kept: %v", got)
	}
}
