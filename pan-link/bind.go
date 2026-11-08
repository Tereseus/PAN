package link

import (
	"errors"
	"net"
	"net/netip"
	"sync"

	"github.com/tailscale/wireguard-go/conn"
)

// AddrBind is a WireGuard UDP bind on one chosen address instead of every interface.
// Tests use 127.0.0.1, which never triggers a firewall prompt. A hub could also use it
// to listen on one interface only.
type AddrBind struct {
	ip netip.Addr
	mu sync.Mutex
	c  *net.UDPConn
}

// NewAddrBind makes a bind for one address (IPv4 or IPv6).
func NewAddrBind(ip netip.Addr) *AddrBind { return &AddrBind{ip: ip.Unmap()} }

type udpEndpoint netip.AddrPort

var (
	_ conn.Bind     = (*AddrBind)(nil)
	_ conn.Endpoint = udpEndpoint{}
)

func (e udpEndpoint) ClearSrc()           {}
func (e udpEndpoint) SrcToString() string { return "" }
func (e udpEndpoint) DstToString() string { return netip.AddrPort(e).String() }
func (e udpEndpoint) DstToBytes() []byte {
	b, _ := netip.AddrPort(e).MarshalBinary()
	return b
}
func (e udpEndpoint) DstIP() netip.Addr { return netip.AddrPort(e).Addr() }
func (e udpEndpoint) SrcIP() netip.Addr { return netip.Addr{} }

func (b *AddrBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.c != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	network := "udp4"
	if b.ip.Is6() {
		network = "udp6"
	}
	c, err := net.ListenUDP(network, net.UDPAddrFromAddrPort(netip.AddrPortFrom(b.ip, port)))
	if err != nil {
		return nil, 0, err
	}
	b.c = c
	recv := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		n, ap, err := c.ReadFromUDPAddrPort(packets[0])
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return 0, net.ErrClosed
			}
			return 0, err
		}
		sizes[0] = n
		eps[0] = udpEndpoint(netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()))
		return 1, nil
	}
	return []conn.ReceiveFunc{recv}, uint16(c.LocalAddr().(*net.UDPAddr).Port), nil
}

func (b *AddrBind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.c == nil {
		return nil
	}
	err := b.c.Close()
	b.c = nil
	return err
}

func (b *AddrBind) SetMark(uint32) error { return nil }

func (b *AddrBind) Send(bufs [][]byte, ep conn.Endpoint, offset int) error {
	b.mu.Lock()
	c := b.c
	b.mu.Unlock()
	if c == nil {
		return net.ErrClosed
	}
	dst, ok := ep.(udpEndpoint)
	if !ok {
		return errors.New("pan-link: endpoint from another bind")
	}
	for _, buf := range bufs {
		if _, err := c.WriteToUDPAddrPort(buf[offset:], netip.AddrPort(dst)); err != nil {
			return err
		}
	}
	return nil
}

func (b *AddrBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return nil, err
	}
	return udpEndpoint(netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())), nil
}

func (b *AddrBind) BatchSize() int { return 1 }
