package link

import (
	"context"
	"encoding/binary"
	"net"
	"net/netip"
	"os"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// stunAnswer builds a binding answer the way a server does (XOR-MAPPED-ADDRESS).
func stunAnswer(txid [12]byte, seen netip.AddrPort) []byte {
	ip := seen.Addr().AsSlice()
	key := append(binary.BigEndian.AppendUint32(nil, stunMagic), txid[:]...)
	for i := range ip {
		ip[i] ^= key[i]
	}
	fam := byte(1)
	if seen.Addr().Is6() {
		fam = 2
	}
	attr := []byte{0, fam}
	attr = binary.BigEndian.AppendUint16(attr, seen.Port()^(stunMagic>>16))
	attr = append(attr, ip...)
	p := make([]byte, 20, 20+4+len(attr))
	binary.BigEndian.PutUint16(p[0:], stunBindingOK)
	binary.BigEndian.PutUint16(p[2:], uint16(4+len(attr)))
	binary.BigEndian.PutUint32(p[4:], stunMagic)
	copy(p[8:], txid[:])
	p = binary.BigEndian.AppendUint16(p, stunAttrXMapped)
	p = binary.BigEndian.AppendUint16(p, uint16(len(attr)))
	return append(p, attr...)
}

func TestSTUNAnswerParses(t *testing.T) {
	txid := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	for _, want := range []string{"198.51.100.66:2395", "[2001:db8:6c30:6110::83]:41720"} {
		ap := netip.MustParseAddrPort(want)
		gotID, got, ok := parseSTUNReply(stunAnswer(txid, ap))
		if !ok || got != ap || gotID != txid {
			t.Fatalf("%s: got %v %v ok=%v", want, got, gotID, ok)
		}
	}
	// A WireGuard handshake start is never taken for STUN.
	wg := make([]byte, 148)
	wg[0] = 1
	binary.BigEndian.PutUint32(wg[4:], stunMagic)
	if looksLikeSTUN(wg) {
		t.Fatal("a WireGuard packet looked like STUN")
	}
	if _, _, ok := parseSTUNReply(stunRequest(txid)); ok {
		t.Fatal("a request parsed as an answer")
	}
}

// fakeSTUN answers binding requests; shift is added to the port it reports, so two
// servers with different shifts look like a network of the hard kind.
func fakeSTUN(t *testing.T, shift uint16) string {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := c.ReadFromUDPAddrPort(buf)
			if err != nil {
				return
			}
			if n < 20 || binary.BigEndian.Uint16(buf[0:]) != stunBindingReq {
				continue
			}
			var txid [12]byte
			copy(txid[:], buf[8:20])
			seen := netip.AddrPortFrom(from.Addr().Unmap(), from.Port()+shift)
			c.WriteToUDPAddrPort(stunAnswer(txid, seen), from)
		}
	}()
	return c.LocalAddr().String()
}

// openSTUN opens a STUN bind on 127.0.0.1 and pumps its receive loop; packets that are
// not STUN come out of the returned channel, as WireGuard would get them.
func openSTUN(t *testing.T, servers []string) (*STUNBind, uint16, chan []byte) {
	t.Helper()
	b := NewSTUNBind(NewAddrBind(netip.MustParseAddr("127.0.0.1")), servers)
	fns, port, err := b.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	through := make(chan []byte, 8)
	go func() {
		packets := [][]byte{make([]byte, 1500)}
		sizes := make([]int, 1)
		eps := make([]conn.Endpoint, 1)
		for {
			n, err := fns[0](packets, sizes, eps)
			if err != nil {
				return
			}
			if n > 0 {
				through <- append([]byte(nil), packets[0][:sizes[0]]...)
			}
		}
	}()
	return b, port, through
}

func waitOutside(t *testing.T, b *STUNBind, servers int) OutsideAddrs {
	t.Helper()
	for i := 0; i < 100; i++ {
		if o := b.Outside(); o.Servers >= servers {
			return o
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("only %d of %d servers answered", b.Outside().Servers, servers)
	return OutsideAddrs{}
}

func TestSTUNBindLearnsItsOutsideAddress(t *testing.T) {
	b, port, through := openSTUN(t, []string{fakeSTUN(t, 0), fakeSTUN(t, 0)})
	if err := b.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	o := waitOutside(t, b, 2)
	want := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)
	if o.V4 != want || o.Hard {
		t.Fatalf("outside %+v, want %v and not hard", o, want)
	}

	// WireGuard's own packets still come through, and the STUN answers did not.
	c, err := net.Dial("udp4", want.String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte{1, 0, 0, 0, 9, 9, 9, 9})
	select {
	case p := <-through:
		if len(p) != 8 || p[0] != 1 {
			t.Fatalf("got %v through, want the WireGuard packet", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the WireGuard packet did not come through")
	}
	select {
	case p := <-through:
		t.Fatalf("a second packet came through: %v", p)
	default:
	}
}

func TestSTUNBindSeesAHardNetwork(t *testing.T) {
	b, _, _ := openSTUN(t, []string{fakeSTUN(t, 0), fakeSTUN(t, 7)})
	if err := b.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if o := waitOutside(t, b, 2); !o.Hard {
		t.Fatalf("outside %+v, want hard: the two servers saw different ports", o)
	}
}

func TestSTUNAnswersGoStale(t *testing.T) {
	b, _, _ := openSTUN(t, []string{fakeSTUN(t, 0)})
	if err := b.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitOutside(t, b, 1)
	b.mu.Lock()
	b.now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	b.mu.Unlock()
	if o := b.Outside(); o.Servers != 0 || o.V4.IsValid() {
		t.Fatalf("outside %+v after 3 minutes, want nothing", o)
	}
}

// Against the real public servers: PAN_LINK_LIVE=1 go test -run STUNLive -v
func TestSTUNLive(t *testing.T) {
	if os.Getenv("PAN_LINK_LIVE") == "" {
		t.Skip("set PAN_LINK_LIVE=1 to ask the real address-check servers")
	}
	b := NewSTUNBind(NewAddrBind(netip.MustParseAddr("0.0.0.0")), nil)
	fns, port, err := b.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	go func() {
		packets, sizes, eps := [][]byte{make([]byte, 1500)}, make([]int, 1), make([]conn.Endpoint, 1)
		for {
			if _, err := fns[0](packets, sizes, eps); err != nil {
				return
			}
		}
	}()
	if err := b.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	o := waitOutside(t, b, 2)
	t.Logf("local port %d, outside %v, hard %v, %d servers answered", port, o.V4, o.Hard, o.Servers)
	if !o.V4.IsValid() {
		t.Fatal("no outside IPv4 address")
	}
}
