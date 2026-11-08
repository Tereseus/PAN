package link

import (
	"context"
	"errors"
	"net"
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
	// After settling, traffic goes only to the address that worked, and still flows.
	if body, err := get(t, l, "/after", nil); err != nil || !strings.HasPrefix(body, st.DeviceID) {
		t.Fatalf("after settling: %q %v", body, err)
	}
	t.Logf("pairing %v, connecting %v, via %s", pairTook.Round(time.Millisecond), took.Round(time.Millisecond), ep)
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
