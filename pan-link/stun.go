package link

// The link's own outside address, for meeting in the middle (docs/INSTALL-PLAN.md, reach
// order 4; owner, 2026-11-15: no Tailscale account for anyone, no relay, nothing hosted).
//
// A home that shares its IPv4 address with other homes (CGNAT), or whose router blocks
// incoming IPv6, lets a packet in only from an address the home side has already sent to.
// Measured on the owner's Starlink that day: a packet from outside to the address a STUN
// server reported never arrived, not even after the home computer had sent to the sender's
// IP on another port. So the hub and the device each have to know the other's outside
// address and send at the same moment. This file is the first half: asking free public
// STUN servers "what address do you see me at?" from the very socket WireGuard uses, so
// the answer is the address the other side has to send to.
//
// It also says when that cannot work on IPv4: a network that shows a different address or
// port to each server (the hard kind; the owner's second site and many phone networks)
// gives the other side nothing to aim at. Such a device still connects over IPv6, where
// there is no address sharing, when both ends have it.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// DefaultSTUNServers are free public address-check servers, none of them ours. A setting
// can replace the list: Google's are not reachable from every country.
var DefaultSTUNServers = []string{
	"stun.l.google.com:19302",
	"stun.cloudflare.com:3478",
	"stun1.l.google.com:19302",
}

const (
	stunMagic       = 0x2112A442
	stunBindingReq  = 0x0001
	stunBindingOK   = 0x0101
	stunAttrMapped  = 0x0001
	stunAttrXMapped = 0x0020
	// An answer older than this no longer describes the socket's mapping.
	stunFresh = 2 * time.Minute
)

// punchPacket is what one side sends toward the other's outside address to open its own
// router and provider for the reply (Link.Punch). It carries nothing; the other side's
// STUNBind takes it out of the stream, and WireGuard would drop it anyway (unknown type).
var punchPacket = []byte("PAN-PUNCH")

// STUNServers replaces DefaultSTUNServers for every link this program starts (a setting).
var STUNServers []string

// stunRequest is a STUN binding request with the given transaction id.
func stunRequest(txid [12]byte) []byte {
	p := make([]byte, 20)
	binary.BigEndian.PutUint16(p[0:], stunBindingReq)
	binary.BigEndian.PutUint32(p[4:], stunMagic)
	copy(p[8:], txid[:])
	return p
}

// looksLikeSTUN reports a STUN binding answer. A WireGuard packet starts with its type
// (1 to 4) and three zero bytes, so its second byte is never 1.
func looksLikeSTUN(p []byte) bool {
	return len(p) >= 20 && binary.BigEndian.Uint16(p[0:]) == stunBindingOK && binary.BigEndian.Uint32(p[4:]) == stunMagic
}

// parseSTUNReply returns the transaction id and the address the server saw.
func parseSTUNReply(p []byte) (txid [12]byte, mapped netip.AddrPort, ok bool) {
	if !looksLikeSTUN(p) {
		return txid, mapped, false
	}
	copy(txid[:], p[8:20])
	end := 20 + int(binary.BigEndian.Uint16(p[2:]))
	if end > len(p) {
		end = len(p)
	}
	var plain netip.AddrPort
	for i := 20; i+4 <= end; {
		typ := binary.BigEndian.Uint16(p[i:])
		l := int(binary.BigEndian.Uint16(p[i+2:]))
		v := p[i+4:]
		if l > len(v) {
			break
		}
		v = v[:l]
		if (typ == stunAttrXMapped || typ == stunAttrMapped) && len(v) >= 8 {
			port := binary.BigEndian.Uint16(v[2:])
			var ip []byte
			switch {
			case v[1] == 1:
				ip = append(ip, v[4:8]...)
			case v[1] == 2 && len(v) >= 20:
				ip = append(ip, v[4:20]...)
			}
			if ip != nil {
				if typ == stunAttrXMapped {
					port ^= stunMagic >> 16
					key := append(binary.BigEndian.AppendUint32(nil, stunMagic), txid[:]...)
					for k := range ip {
						ip[k] ^= key[k]
					}
				}
				if a, good := netip.AddrFromSlice(ip); good {
					ap := netip.AddrPortFrom(a.Unmap(), port)
					if typ == stunAttrXMapped {
						return txid, ap, true
					}
					plain = ap
				}
			}
		}
		i += 4 + l + (4-l%4)%4
	}
	return txid, plain, plain.IsValid()
}

// OutsideAddrs is what the address-check servers saw.
type OutsideAddrs struct {
	V4 netip.AddrPort // the socket's outside IPv4 address and port, if any server answered
	V6 netip.AddrPort // the same over IPv6 (no address sharing there: this is the device's own address)
	// Hard: two servers saw different IPv4 addresses or ports, so nothing outside can aim
	// at this socket over IPv4. IPv6 is then the only direct way in.
	Hard bool
	// Sure: two servers saw the same IPv4 address and port (or only one server is set up),
	// so the network is known not to be the hard kind. One answer alone cannot tell.
	Sure    bool
	Servers int // servers that answered recently
}

// AimV4 reports an IPv4 outside address the other side can aim at.
func (o OutsideAddrs) AimV4() bool { return o.V4.IsValid() && !o.Hard && o.Sure }

type stunSeen struct {
	addr netip.AddrPort
	at   time.Time
}

// STUNBind wraps a WireGuard bind and learns the socket's outside address. STUN answers
// are taken out of the stream before WireGuard sees them.
type STUNBind struct {
	conn.Bind
	servers []string
	resolve func(ctx context.Context, host string) ([]netip.Addr, error)
	now     func() time.Time

	mu      sync.Mutex
	pending map[[12]byte]string // transaction -> the server address it went to
	seen    map[string]stunSeen // server address -> what it saw
}

// NewSTUNBind wraps inner. With no servers it uses DefaultSTUNServers.
func NewSTUNBind(inner conn.Bind, servers []string) *STUNBind {
	if len(servers) == 0 {
		servers = DefaultSTUNServers
	}
	return &STUNBind{
		Bind:    inner,
		servers: servers,
		resolve: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		now:     time.Now,
		pending: map[[12]byte]string{},
		seen:    map[string]stunSeen{},
	}
}

func (s *STUNBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := s.Bind.Open(port)
	if err != nil {
		return nil, 0, err
	}
	out := make([]conn.ReceiveFunc, len(fns))
	for i, fn := range fns {
		fn := fn
		out[i] = func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
			for {
				n, err := fn(packets, sizes, eps)
				if err != nil {
					return n, err
				}
				kept := 0
				for k := 0; k < n; k++ {
					if s.take(packets[k][:sizes[k]]) {
						continue
					}
					if kept != k {
						copy(packets[kept], packets[k][:sizes[k]])
						sizes[kept] = sizes[k]
						eps[kept] = eps[k]
					}
					kept++
				}
				if kept > 0 || n == 0 {
					return kept, nil
				}
			}
		}
	}
	return out, actual, nil
}

// take records a STUN answer to one of our requests and reports whether p was one.
func (s *STUNBind) take(p []byte) bool {
	if bytes.Equal(p, punchPacket) {
		return true
	}
	txid, mapped, ok := parseSTUNReply(p)
	if !ok {
		return looksLikeSTUN(p) // an answer we cannot read is still not WireGuard's
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	server, ours := s.pending[txid]
	if !ours {
		return true
	}
	delete(s.pending, txid)
	s.seen[server] = stunSeen{addr: mapped, at: s.now()}
	return true
}

// Probe asks every server once, over IPv4 and IPv6 where the server has both. The answers
// arrive through the bind's receive loop; read them with Outside a moment later. Call it
// every 20 s or so: the requests also keep the outside address alive.
func (s *STUNBind) Probe(ctx context.Context) error {
	sent := 0
	var last error
	for _, hp := range s.servers {
		host, port, err := net.SplitHostPort(hp)
		if err != nil {
			last = err
			continue
		}
		var ips []netip.Addr
		if a, err := netip.ParseAddr(host); err == nil {
			ips = []netip.Addr{a}
		} else if ips, err = s.resolve(ctx, host); err != nil {
			last = err
			continue
		}
		var did4, did6 bool
		for _, ip := range ips {
			ip = ip.Unmap()
			if (ip.Is4() && did4) || (ip.Is6() && did6) {
				continue
			}
			target := net.JoinHostPort(ip.String(), port)
			ep, err := s.Bind.ParseEndpoint(target)
			if err != nil {
				last = err
				continue
			}
			var txid [12]byte
			rand.Read(txid[:])
			s.mu.Lock()
			if len(s.pending) > 64 { // unanswered requests from dead servers
				s.pending = map[[12]byte]string{}
			}
			s.pending[txid] = target
			s.mu.Unlock()
			if err := s.Bind.Send([][]byte{stunRequest(txid)}, ep, 0); err != nil {
				last = err
				continue
			}
			sent++
			if ip.Is4() {
				did4 = true
			} else {
				did6 = true
			}
		}
	}
	if sent == 0 {
		if last == nil {
			last = errors.New("pan-link: no address-check server to ask")
		}
		return last
	}
	return nil
}

// Punch sends one small packet from WireGuard's socket to each address ("ip:port") and
// returns how many went out. The packet opens this side's router and provider for
// whatever comes back from exactly that address.
func (s *STUNBind) Punch(addrs []string) int {
	n := 0
	for _, a := range addrs {
		ap, err := netip.ParseAddrPort(a)
		if err != nil || IsTailnet(ap.Addr()) {
			continue
		}
		ep, err := s.Bind.ParseEndpoint(netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()).String())
		if err != nil {
			continue
		}
		if s.Bind.Send([][]byte{append([]byte(nil), punchPacket...)}, ep, 0) == nil {
			n++
		}
	}
	return n
}

// Strings is the outside addresses the other side can aim at: IPv6 first (no address
// sharing there), then IPv4 unless this network is the hard kind.
func (o OutsideAddrs) Strings() []string {
	var out []string
	if o.V6.IsValid() {
		out = append(out, o.V6.String())
	}
	if o.AimV4() {
		out = append(out, o.V4.String())
	}
	return out
}

// Outside is what the servers saw in the last two minutes.
func (s *STUNBind) Outside() OutsideAddrs {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var v4, v6 []netip.AddrPort
	servers := 0
	keys := make([]string, 0, len(s.seen))
	for k := range s.seen {
		keys = append(keys, k)
	}
	sort.Strings(keys) // a steady answer when servers disagree
	for _, k := range keys {
		e := s.seen[k]
		if now.Sub(e.at) > stunFresh {
			delete(s.seen, k)
			continue
		}
		servers++
		if e.addr.Addr().Is4() {
			v4 = append(v4, e.addr)
		} else {
			v6 = append(v6, e.addr)
		}
	}
	out := OutsideAddrs{Servers: servers}
	if len(v4) > 0 {
		out.V4 = v4[0]
		for _, a := range v4[1:] {
			if a != v4[0] {
				out.Hard = true
			}
		}
		out.Sure = !out.Hard && (len(v4) >= 2 || len(s.servers) == 1)
	}
	if len(v6) > 0 {
		out.V6 = v6[0]
	}
	return out
}
