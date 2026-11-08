package linkmode

import (
	"errors"
	"net"
	"net/netip"
	"sync"

	link "dev.pan/link"
	"github.com/tailscale/wireguard-go/conn"
)

// IsTailnet reports a Tailscale address.
func IsTailnet(ip netip.Addr) bool { return link.IsTailnet(ip) }

// TailnetDialer opens a UDP socket on this phone's own Tailscale address (IPv4, or IPv6
// when v6 is set). It fails while Tailscale is off; the bind asks again on the next packet.
type TailnetDialer func(v6 bool) (net.PacketConn, error)

// TailnetBind sends pan-link's packets for Tailscale addresses through the app's own
// Tailscale (tsnet), and everything else through the phone's normal sockets. The phone's
// system has no route to Tailscale addresses, only tsnet does, so without this a phone
// whose only way to the hub is its in-app Tailscale can't use the link: home Wi-Fi that
// keeps devices apart, or away from a home whose router lets nothing in.
func TailnetBind(inner conn.Bind, dial TailnetDialer) conn.Bind {
	return &tailnetBind{Bind: inner, dial: dial}
}

type tailnetBind struct {
	conn.Bind
	dial TailnetDialer

	mu   sync.Mutex
	pcs  [2]net.PacketConn // IPv4, IPv6; nil until first used or after Tailscale restarted
	in   chan tailnetPacket
	done chan struct{} // closed by Close; nil while closed
}

type tailnetPacket struct {
	b    []byte
	from netip.AddrPort
}

// tailnetEndpoint is a hub address reached through Tailscale.
type tailnetEndpoint struct{ ap netip.AddrPort }

func (e tailnetEndpoint) ClearSrc()           {}
func (e tailnetEndpoint) SrcToString() string { return "" }
func (e tailnetEndpoint) DstToString() string { return e.ap.String() }
func (e tailnetEndpoint) DstToBytes() []byte  { b, _ := e.ap.MarshalBinary(); return b }
func (e tailnetEndpoint) DstIP() netip.Addr   { return e.ap.Addr() }
func (e tailnetEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }

func (t *tailnetBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := t.Bind.Open(port)
	if err != nil {
		return nil, 0, err
	}
	in, done := make(chan tailnetPacket, 64), make(chan struct{})
	t.mu.Lock()
	t.in, t.done = in, done
	t.mu.Unlock()
	// One more receive function: packets that arrived through Tailscale. It waits while
	// Tailscale is off rather than failing, since WireGuard stops reading after errors.
	recv := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		select {
		case p := <-in:
			sizes[0] = copy(packets[0], p.b)
			eps[0] = tailnetEndpoint{p.from}
			return 1, nil
		case <-done:
			return 0, net.ErrClosed
		}
	}
	return append(fns, recv), actual, nil
}

func (t *tailnetBind) Close() error {
	t.mu.Lock()
	if t.done != nil {
		close(t.done)
		t.done = nil
	}
	for i, pc := range t.pcs {
		if pc != nil {
			pc.Close()
			t.pcs[i] = nil
		}
	}
	t.mu.Unlock()
	return t.Bind.Close()
}

func (t *tailnetBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if ap, err := netip.ParseAddrPort(s); err == nil && IsTailnet(ap.Addr()) {
		return tailnetEndpoint{netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())}, nil
	}
	return t.Bind.ParseEndpoint(s)
}

func (t *tailnetBind) Send(bufs [][]byte, ep conn.Endpoint, offset int) error {
	te, ok := ep.(tailnetEndpoint)
	if !ok {
		return t.Bind.Send(bufs, ep, offset)
	}
	pc, err := t.socket(te.ap.Addr().Is6())
	if err != nil {
		return err
	}
	to := net.UDPAddrFromAddrPort(te.ap)
	for _, b := range bufs {
		if _, err := pc.WriteTo(b[offset:], to); err != nil {
			return err
		}
	}
	return nil
}

// socket returns the Tailscale socket for one address family. It opens it, and starts its
// reader, on first use and again after Tailscale restarted.
func (t *tailnetBind) socket(v6 bool) (net.PacketConn, error) {
	i := 0
	if v6 {
		i = 1
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done == nil {
		return nil, net.ErrClosed
	}
	if pc := t.pcs[i]; pc != nil {
		return pc, nil
	}
	if t.dial == nil {
		return nil, errors.New("no Tailscale on this device")
	}
	pc, err := t.dial(v6)
	if err != nil {
		return nil, err
	}
	t.pcs[i] = pc
	go t.read(i, pc, t.in, t.done)
	return pc, nil
}

func (t *tailnetBind) read(i int, pc net.PacketConn, in chan<- tailnetPacket, done <-chan struct{}) {
	buf := make([]byte, 65535)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			// Tailscale stopped or the link closed: forget this socket, so the next
			// packet opens a new one.
			t.mu.Lock()
			if t.pcs[i] == pc {
				t.pcs[i] = nil
			}
			t.mu.Unlock()
			pc.Close()
			return
		}
		ap, err := netip.ParseAddrPort(from.String())
		if err != nil {
			continue
		}
		p := tailnetPacket{b: append([]byte(nil), buf[:n]...), from: netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())}
		select {
		case in <- p:
		case <-done:
			return
		}
	}
}
