package link

import (
	"context"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// strictBind is a network that lets a packet in only from an address this side has
// already sent to, like the owner's Starlink home (measured 2026-11-15) and most phone
// networks. Off, it is a home network where everything arrives.
type strictBind struct {
	conn.Bind
	strict  atomic.Bool
	dropped atomic.Int32
	mu      sync.Mutex
	sent    map[string]bool
}

func newStrictBind() *strictBind {
	return &strictBind{Bind: NewAddrBind(loopback), sent: map[string]bool{}}
}

func (b *strictBind) Send(bufs [][]byte, ep conn.Endpoint, offset int) error {
	b.mu.Lock()
	b.sent[ep.DstToString()] = true
	b.mu.Unlock()
	return b.Bind.Send(bufs, ep, offset)
}

func (b *strictBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.Bind.Open(port)
	if err != nil {
		return nil, 0, err
	}
	out := make([]conn.ReceiveFunc, len(fns))
	for i, fn := range fns {
		fn := fn
		out[i] = func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
			for {
				n, err := fn(packets, sizes, eps)
				if err != nil || n == 0 || !b.strict.Load() {
					return n, err
				}
				b.mu.Lock()
				ok := b.sent[eps[0].DstToString()]
				b.mu.Unlock()
				if ok {
					return n, nil
				}
				b.dropped.Add(1)
			}
		}
	}
	return out, actual, nil
}

// meetSettings makes the timings short and lets 127.0.0.1 count as an outside address.
func meetSettings(t *testing.T) {
	t.Helper()
	ok, off, every, servers, find := outsideOK, offlineAfter, lookupEvery, STUNServers, findEvery
	outsideOK = func(netip.Addr) bool { return true }
	offlineAfter = 300 * time.Millisecond
	lookupEvery = func(time.Duration) time.Duration { return 200 * time.Millisecond }
	findEvery = func(time.Duration, bool) time.Duration { return 300 * time.Millisecond }
	t.Cleanup(func() {
		outsideOK, offlineAfter, lookupEvery, STUNServers, findEvery = ok, off, every, servers, find
	})
}

// every runs fn about every d until the test ends.
func every(t *testing.T, d time.Duration, fn func()) {
	t.Helper()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			case <-time.After(d):
				fn()
			}
		}
	}()
	t.Cleanup(func() { close(stop); <-done })
}

// A phone paired at home goes out. Both its network and the home's drop every packet
// from an address they have not sent to. With both sides doing their part (the phone
// leaves its outside address where the hub looks, the hub punches toward it), the phone's
// handshake gets in. No relay carries anything.
func TestMeetInTheMiddle(t *testing.T) {
	meetSettings(t)
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	relay := newFakeRelay(t)
	ctx := context.Background()

	STUNServers = []string{fakeSTUN(t, 0), fakeSTUN(t, 0)}
	hubBind := newStrictBind()
	th := newTestHub(t, pan.URL, hubBind, "", nil)
	th.hub.Relays = []string{relay.URL}
	var punched atomic.Int32
	th.hub.OnPunch = func(Device, []string) { punched.Add(1) }

	info, _ := th.hub.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(ctx, uri, "", func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}

	// Away from home: strict on both sides.
	hubBind.strict.Store(true)
	phoneBind := newStrictBind()
	phoneBind.strict.Store(true)
	phone, err := Open(ctx, st, func() conn.Bind { return phoneBind })
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	if _, err := getWithin(phone, "/before", 1500*time.Millisecond); err == nil {
		t.Fatal("the phone got in with nobody punching")
	}
	if hubBind.dropped.Load() == 0 {
		t.Fatal("the home network dropped nothing: the test proves nothing")
	}

	m := &Meeter{Link: phone, State: func() ClientState { return *st }, Relays: []string{relay.URL}}
	every(t, 100*time.Millisecond, func() { th.hub.PunchTick(ctx) })
	every(t, 100*time.Millisecond, func() { m.Tick(ctx, false, "", nil) })

	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := getWithin(phone, "/after", 2*time.Second); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no direct path after 15 s (hub punched %d times, relay took %d records, outside %+v)",
				punched.Load(), relay.puts.Load(), phone.Outside())
		}
	}
	if punched.Load() == 0 {
		t.Fatal("connected without the hub ever punching")
	}
}

// While the phone is out, another device is removed, which changes the key of the hub's
// shared address record, and the hub is no longer at the address the phone knows. The
// phone's own record and the hub's answer to it are made from the pair secret (the two
// WireGuard keys), not from that shared key, so the phone still finds the hub and gets in.
func TestRemovingADeviceDoesNotStrandTheOthers(t *testing.T) {
	meetSettings(t)
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	relay := newFakeRelay(t)
	relays := []string{relay.URL}
	ctx := context.Background()

	STUNServers = []string{fakeSTUN(t, 0), fakeSTUN(t, 0)}
	hubBind := newStrictBind()
	th := newTestHub(t, pan.URL, hubBind, "", nil)
	th.hub.Relays = relays
	var punched atomic.Int32
	th.hub.OnPunch = func(Device, []string) { punched.Add(1) }

	pair := func(name string) *ClientState {
		info, _ := th.hub.StartPairing(name, 0)
		uri, _ := info.URI()
		st, err := Pair(ctx, uri, "", func() conn.Bind { return NewAddrBind(loopback) })
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	st := pair("Pixel")
	tablet := pair("Old tablet")
	if st.RecordSecret == "" {
		t.Fatal("pairing gave the phone no record secret: the test proves nothing")
	}
	if _, err := th.hub.PublishAddresses(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := FindHub(ctx, st, relays, nil); err != nil {
		t.Fatalf("the phone cannot read the shared record even before the removal: %v", err)
	}

	if err := th.hub.RemoveDevice(tablet.DeviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := th.hub.PublishAddresses(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := FindHub(ctx, st, relays, nil); err == nil {
		t.Fatal("the phone still opens the shared record after the removal: the test proves nothing")
	}

	// Away from home, strict on both sides, knowing only an address the hub is not at.
	away := *st
	away.Endpoints = []string{"127.0.0.1:9"}
	hubBind.strict.Store(true)
	phoneBind := newStrictBind()
	phoneBind.strict.Store(true)
	phone, err := Open(ctx, &away, func() conn.Bind { return phoneBind })
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	if _, err := getWithin(phone, "/before", 1500*time.Millisecond); err == nil {
		t.Fatal("the phone got in without knowing where the hub is")
	}

	var learned atomic.Int32
	var said sync.Map
	m := &Meeter{Link: phone, State: func() ClientState { return away }, Relays: relays,
		Log: func(s string) { said.Store(s, true) }}
	every(t, 100*time.Millisecond, func() { th.hub.PunchTick(ctx) })
	every(t, 100*time.Millisecond, func() {
		m.Tick(ctx, false, "", func(addrs []string, seq uint64, added int) { learned.Add(int32(added)) })
	})

	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := getWithin(phone, "/after", 2*time.Second); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no path after 15 s (hub punched %d times, relay took %d records, phone learned %d addresses)",
				punched.Load(), relay.puts.Load(), learned.Load())
		}
	}
	if learned.Load() == 0 {
		t.Fatal("connected without learning the hub's address from its answer")
	}
	if _, ok := said.Load("the hub's addresses came from its answer to this device"); !ok {
		t.Fatal("the phone never said the address came from the hub's answer")
	}
}

// A phone that has been on the backup route all along (Tailscale, here a relay) knows only
// that route's address for the hub: it never had a reason to read the address record. It
// tells the hub its outside address through the tunnel; the hub punches and answers with
// its own direct address. Then the backup route goes away, and the link must still work.
// (The owner's phone, 2026-11-15: the hub punched, the phone stayed on the backup route.)
func TestBackupRouteMovesToDirect(t *testing.T) {
	meetSettings(t)
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	ctx := context.Background()

	STUNServers = []string{fakeSTUN(t, 0), fakeSTUN(t, 0)}
	hubBind := newStrictBind()
	th := newTestHub(t, pan.URL, hubBind, "", nil)
	info, _ := th.hub.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(ctx, uri, "", func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}

	// The backup route: always open at the hub, whatever the home lets in.
	backup := newRelay(t, th.hub.Endpoints()[0])
	hubBind.mu.Lock()
	hubBind.sent[backup.back.LocalAddr().String()] = true
	hubBind.mu.Unlock()
	hubBind.strict.Store(true)

	away := *st
	away.Endpoints = []string{backup.front.LocalAddr().String()}
	phoneBind := newStrictBind()
	phoneBind.strict.Store(true)
	phone, err := Open(ctx, &away, func() conn.Bind { return phoneBind })
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	if _, err := getWithin(phone, "/backup", 5*time.Second); err != nil {
		t.Fatalf("the backup route does not work: %v", err)
	}

	var learned atomic.Int32
	m := &Meeter{Link: phone, State: func() ClientState { return away }}
	every(t, 100*time.Millisecond, func() { th.hub.PunchTick(ctx) })
	every(t, 100*time.Millisecond, func() {
		m.Tick(ctx, true, "tailscale", func(addrs []string, seq uint64, added int) { learned.Add(int32(added)) })
	})
	deadline := time.Now().Add(10 * time.Second)
	for learned.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the phone never learned the hub's direct address (outside %+v)", phone.Outside())
		}
		time.Sleep(50 * time.Millisecond)
	}

	backup.down.Store(true)
	phone.Rehandshake(away.HubKey)
	deadline = time.Now().Add(15 * time.Second)
	for {
		if _, err := getWithin(phone, "/direct", 2*time.Second); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("with the backup route gone the link did not move to the direct path")
		}
	}
}

// A phone on a network of the hard kind (a different outside port for every destination)
// has no IPv4 address the hub could aim at, so it leaves none.
func TestHardNetworkPublishesNothing(t *testing.T) {
	meetSettings(t)
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	relay := newFakeRelay(t)
	ctx := context.Background()

	STUNServers = []string{fakeSTUN(t, 0)}
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	info, _ := th.hub.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(ctx, uri, "", func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}

	STUNServers = []string{fakeSTUN(t, 0), fakeSTUN(t, 9)} // the two servers see different ports
	phone, err := Open(ctx, st, func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	m := &Meeter{Link: phone, State: func() ClientState { return *st }, Relays: []string{relay.URL}}
	for i := 0; i < 10; i++ {
		m.Tick(ctx, false, "", nil)
		time.Sleep(50 * time.Millisecond)
	}
	o := phone.Outside()
	if !o.Hard || len(o.Strings()) != 0 {
		t.Fatalf("outside %+v, want hard with nothing to aim at", o)
	}
	if n := relay.puts.Load(); n != 0 {
		t.Fatalf("published %d records from a hard network", n)
	}
}

// Over a path that is already up, the device tells the hub its outside address through
// the tunnel and the hub punches at once. A limited device may do this too.
func TestTellHubOutsideThroughTheTunnel(t *testing.T) {
	meetSettings(t)
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	ctx := context.Background()
	STUNServers = []string{fakeSTUN(t, 0)}
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	var got []string
	var mu sync.Mutex
	th.hub.OnPunch = func(_ Device, addrs []string) { mu.Lock(); got = addrs; mu.Unlock() }
	info, _ := th.hub.StartPairingLimited("ProDesk", 0, []string{"POST /api/v1/alerts"})
	uri, _ := info.URI()
	binds := func() conn.Bind { return NewAddrBind(loopback) }
	st, err := Pair(ctx, uri, "", binds)
	if err != nil {
		t.Fatal(err)
	}
	l, _, err := Connect(ctx, st, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	want := []string{"127.0.0.1:40001", "[::1]:40002"}
	hubAddrs, err := TellHubOutside(ctx, l, st, append(want, "not an address", "127.0.0.1:0"))
	if err != nil {
		t.Fatal(err)
	}
	if ours := th.hub.Endpoints(); len(hubAddrs) != len(ours) || hubAddrs[0] != ours[0] {
		t.Fatalf("hub answered with addresses %v, want its own %v", hubAddrs, ours)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("hub punched toward %v, want %v", got, want)
	}
}

// Against Pkarr's real relays: PAN_LINK_LIVE=1 go test -run DeviceRecordLive -v
func TestDeviceRecordLive(t *testing.T) {
	if os.Getenv("PAN_LINK_LIVE") == "" {
		t.Skip("set PAN_LINK_LIVE=1 to use Pkarr's real relays")
	}
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	th := newTestHub(t, pan.URL, NewAddrBind(loopback), "", nil)
	info, _ := th.hub.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"[2001:db8::7]:41000", "198.51.100.7:41000"}
	ok := outsideOK
	outsideOK = func(netip.Addr) bool { return true }
	defer func() { outsideOK = ok }()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	t0 := time.Now()
	if err := PublishOutside(ctx, st, want, nil, nil); err != nil {
		t.Fatal(err)
	}
	published := time.Since(t0)
	var dev Device
	for _, d := range th.hub.Devices() {
		dev = d
	}
	t1 := time.Now()
	got, seq, err := th.hub.FindDevice(ctx, dev)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("published in %v, found in %v (seq %d): %v", published.Round(time.Millisecond), time.Since(t1).Round(time.Millisecond), seq, got)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("found %v, want %v", got, want)
	}
	// And the hub's answer, for this device alone.
	t2 := time.Now()
	if did, err := th.hub.PublishReply(ctx, dev); err != nil || !did {
		t.Fatalf("hub's answer: published %v, %v", did, err)
	}
	answered := time.Since(t2)
	t3 := time.Now()
	hubAddrs, err := FindHubReply(ctx, st, nil, nil)
	if err != nil || len(hubAddrs) == 0 {
		t.Fatalf("hub's answer not found: %v %v", hubAddrs, err)
	}
	t.Logf("hub's answer published in %v, found in %v: %v", answered.Round(time.Millisecond), time.Since(t3).Round(time.Millisecond), hubAddrs)
}

func TestPlainWords(t *testing.T) {
	ap := netip.MustParseAddrPort
	v6, v4 := ap("[2001:db8::83]:41720"), ap("198.51.100.66:39057")
	home := []string{"192.168.1.83:41720", v6.String(), v4.String(), "100.64.0.9:41720"}
	reach := []struct {
		o    OutsideAddrs
		eps  []string
		want string
	}{
		{OutsideAddrs{V4: v4, V6: v6, Sure: true, Servers: 2}, home, "on most networks, with nothing to set up"},
		{OutsideAddrs{V4: v4, V6: v6, Hard: true, Servers: 2}, home, "when their network has IPv6"},
		{OutsideAddrs{V4: v4, Sure: true, Servers: 2}, home, "Some mobile networks will not get through"},
		{OutsideAddrs{V4: v4, Hard: true, Servers: 2}, home, "home network only"},
		{OutsideAddrs{}, []string{"192.168.1.83:41720", "100.64.0.9:41720"}, "Not checked yet"},
		{OutsideAddrs{V4: v4, Hard: true, Servers: 2}, append([]string{"203.0.113.9:41720"}, home...), "on any network"},
	}
	for _, c := range reach {
		if got := ReachWords(c.o, c.eps); !strings.Contains(got, c.want) {
			t.Errorf("ReachWords(%+v) = %q, want it to say %q", c.o, got, c.want)
		}
	}
	away := []struct {
		connected bool
		path      string
		o         OutsideAddrs
		want      string
	}{
		{true, "local", OutsideAddrs{}, "home network"},
		{true, "internet", OutsideAddrs{}, "directly from outside"},
		{true, "tailscale", OutsideAddrs{}, "backup route"},
		{false, "", OutsideAddrs{}, "Checking this network"},
		{false, "", OutsideAddrs{V4: ap("203.0.113.200:33668"), Sure: true, Servers: 2}, "Finding a direct way"},
		{false, "", OutsideAddrs{V4: ap("203.0.113.200:33668"), Servers: 1}, "Checking this network"},
		{false, "", OutsideAddrs{V4: ap("192.0.2.7:7976"), Hard: true, Servers: 2}, "cannot reach your PAN computer directly"},
		{false, "", OutsideAddrs{V4: ap("192.0.2.7:7976"), V6: ap("[2607:fb90::5]:40000"), Hard: true, Servers: 2}, "Finding a direct way"},
	}
	for _, c := range away {
		if got := AwayWords(c.connected, c.path, c.o, home); !strings.Contains(got, c.want) {
			t.Errorf("AwayWords(%v, %q, %+v) = %q, want it to say %q", c.connected, c.path, c.o, got, c.want)
		}
	}
	for addr, want := range map[string]string{"192.168.1.83:41720": "local", "100.64.0.9:41720": "tailscale", v4.String(): "internet", "": ""} {
		if got := PathOf(addr); got != want {
			t.Errorf("PathOf(%q) = %q, want %q", addr, got, want)
		}
	}
}
