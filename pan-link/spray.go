package link

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/tailscale/wireguard-go/conn"
	"github.com/tailscale/wireguard-go/device"
)

// quietBind keeps "port unreachable" style errors from stopping the link. On Windows a
// UDP receive can fail with WSAECONNRESET or WSAENETRESET after sending to an address
// with nothing listening, and wireguard-go stops reading after such an error. That
// would let one dead hub address knock out a device, or one vanished phone the hub.
type quietBind struct{ conn.Bind }

func (q *quietBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := q.Bind.Open(port)
	if err != nil {
		return nil, 0, err
	}
	out := make([]conn.ReceiveFunc, len(fns))
	for i, fn := range fns {
		fn := fn
		out[i] = func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
			for {
				n, err := fn(packets, sizes, eps)
				if err != nil && isICMPError(err) {
					continue
				}
				return n, err
			}
		}
	}
	return out, actual, nil
}

// isICMPError reports a receive error that only means some earlier packet bounced.
func isICMPError(err error) bool {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return false
	}
	if runtime.GOOS == "windows" {
		return en == 10054 || en == 10052 // WSAECONNRESET, WSAENETRESET
	}
	return en == syscall.ECONNREFUSED
}

// sprayBind sends every handshake start to all of the hub's known addresses, and every
// other packet to the address WireGuard picked. Whichever address the hub answers on
// first wins, so a phone away from home does not wait on each dead home address in
// turn. Because each new handshake goes everywhere again, a link whose address died (a
// phone leaving home Wi-Fi) moves to a working path at its next handshake: within about
// 15 s on WireGuard's own timers, or at once after Rehandshake.
type sprayBind struct {
	conn.Bind
	cands []string

	mu  sync.Mutex
	eps []conn.Endpoint // cands, parsed by the inner bind when it opens

	// The latest handshake start and when it went out, so respray can send it again on a
	// network that just came up (Link.Rehandshake).
	lastInit   [][]byte
	lastOffset int
	lastInitAt time.Time
}

func newSprayBind(inner conn.Bind, cands []string) *sprayBind {
	return &sprayBind{Bind: inner, cands: cands}
}

func (s *sprayBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := s.Bind.Open(port)
	if err != nil {
		return nil, 0, err
	}
	var eps []conn.Endpoint
	for _, c := range s.cands {
		if ep, err := s.Bind.ParseEndpoint(c); err == nil {
			eps = append(eps, ep)
		}
	}
	s.mu.Lock()
	s.eps = eps
	s.mu.Unlock()
	return fns, actual, nil
}

func (s *sprayBind) Send(bufs [][]byte, ep conn.Endpoint, offset int) error {
	s.mu.Lock()
	eps := s.eps
	init := len(eps) > 0 && isInitiation(bufs, offset)
	if init {
		s.lastInit, s.lastOffset, s.lastInitAt = copyBufs(bufs), offset, time.Now()
	}
	s.mu.Unlock()
	if !init {
		return s.Bind.Send(bufs, ep, offset)
	}
	return s.sendAll(bufs, eps, ep, offset)
}

// sendAll sends a batch to every hub address. WireGuard's own pick goes too when it isn't
// one of the saved addresses (the hub answered from an address the code didn't list).
//
// Copies for the hub's Tailscale addresses go TailnetDelay later when other addresses
// were sent to, so a direct path (home Wi-Fi, an open router port) answers first whenever
// it works and the link uses it. Tailscale then wins only when nothing else answers, as
// away from a home that lets nothing in, at a cost of TailnetDelay per handshake.
func (s *sprayBind) sendAll(bufs [][]byte, eps []conn.Endpoint, ep conn.Endpoint, offset int) error {
	if ep != nil && !hasEndpoint(eps, ep) {
		eps = append(eps[:len(eps):len(eps)], ep)
	}
	var direct, tailnet []conn.Endpoint
	for _, e := range eps {
		if endpointIsTailnet(e) {
			tailnet = append(tailnet, e)
		} else {
			direct = append(direct, e)
		}
	}
	var firstErr error
	sent := false
	send := func(to []conn.Endpoint) {
		for _, e := range to {
			// Each address gets its own copy: a batching bind may write into the buffers.
			if err := s.Bind.Send(copyBufs(bufs), e, offset); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			sent = true
		}
	}
	send(direct)
	switch {
	case len(tailnet) == 0:
	case !sent:
		send(tailnet) // nothing else could even be sent to, so don't wait
	default:
		held := copyBufs(bufs)
		time.AfterFunc(TailnetDelay, func() {
			for _, e := range tailnet {
				s.Bind.Send(copyBufs(held), e, offset)
			}
		})
	}
	if sent {
		return nil // an address that can't be sent to (no IPv6 here, say) is not an error
	}
	return firstErr
}

// TailnetDelay is how much later a handshake's copies for Tailscale addresses go out
// than those for the hub's other addresses (see sendAll).
const TailnetDelay = 150 * time.Millisecond

var (
	tailnetV4 = netip.MustParsePrefix("100.64.0.0/10")
	tailnetV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

// IsTailnet reports a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48).
func IsTailnet(ip netip.Addr) bool {
	ip = ip.Unmap()
	return tailnetV4.Contains(ip) || tailnetV6.Contains(ip)
}

func endpointIsTailnet(e conn.Endpoint) bool {
	ap, err := netip.ParseAddrPort(e.DstToString())
	return err == nil && IsTailnet(ap.Addr())
}

func copyBufs(bufs [][]byte) [][]byte {
	cp := make([][]byte, len(bufs))
	for i, b := range bufs {
		cp[i] = append([]byte(nil), b...)
	}
	return cp
}

// lastInitTime is when the latest handshake start went out (zero if none yet).
func (s *sprayBind) lastInitTime() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastInitAt
}

// respray sends the latest handshake start again, to every hub address, while WireGuard
// would still accept its answer (it makes a new one after device.RekeyTimeout). The hub
// takes it if the first copies never arrived, which is the case after a network change.
func (s *sprayBind) respray() bool {
	s.mu.Lock()
	bufs, offset, at, eps := s.lastInit, s.lastOffset, s.lastInitAt, s.eps
	s.mu.Unlock()
	if bufs == nil || len(eps) == 0 || time.Since(at) >= device.RekeyTimeout {
		return false
	}
	return s.sendAll(bufs, eps, nil, offset) == nil
}

// isInitiation reports a batch of WireGuard handshake initiations: message type 1, a
// little-endian uint32 at the start of each packet.
func isInitiation(bufs [][]byte, offset int) bool {
	if len(bufs) == 0 {
		return false
	}
	for _, b := range bufs {
		if len(b) < offset+4 || b[offset] != 1 || b[offset+1] != 0 || b[offset+2] != 0 || b[offset+3] != 0 {
			return false
		}
	}
	return true
}

func hasEndpoint(eps []conn.Endpoint, ep conn.Endpoint) bool {
	for _, e := range eps {
		if e.DstToString() == ep.DstToString() {
			return true
		}
	}
	return false
}

// resolveEndpoints turns the saved hub addresses into IP:port strings, looking up any
// names (an --endpoint like home.example.net:41720), and drops repeats.
func resolveEndpoints(ctx context.Context, endpoints []string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(ap netip.AddrPort) {
		s := netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()).String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, e := range endpoints {
		if ap, err := netip.ParseAddrPort(e); err == nil {
			add(ap)
			continue
		}
		host, port, err := net.SplitHostPort(e)
		if err != nil {
			continue
		}
		p, err := net.LookupPort("udp", port)
		if err != nil {
			continue
		}
		lctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ips, _ := net.DefaultResolver.LookupNetIP(lctx, "ip", host)
		cancel()
		for _, ip := range ips {
			add(netip.AddrPortFrom(ip, uint16(p)))
		}
	}
	return out
}

// startSpray brings up a link to the hub whose first packets go to every address at once.
func startSpray(ctx context.Context, priv string, tunnelIP netip.Addr, hubKey string, hubIP netip.Addr,
	endpoints []string, binds BindFactory) (*Link, *sprayBind, error) {
	cands := resolveEndpoints(ctx, endpoints)
	if len(cands) == 0 {
		return nil, nil, errors.New("no address to try")
	}
	sb := newSprayBind(defaultBinds(binds)(), cands)
	l, err := Start(Config{PrivateKey: priv, TunnelIP: tunnelIP, Bind: sb,
		Peers: []Peer{{PublicKey: hubKey, TunnelIP: hubIP, Endpoint: cands[0], KeepaliveSec: KeepaliveSec}}})
	if err != nil {
		return nil, nil, err
	}
	l.spray = sb
	return l, sb, nil
}

// PeerEndpoint is the address WireGuard currently uses for a peer. It follows the
// peer's real address from the packets it sends (roaming).
func (l *Link) PeerEndpoint(publicKey string) (string, error) {
	pub, err := keyHex(publicKey)
	if err != nil {
		return "", err
	}
	eps, err := l.peerEndpoints()
	if err != nil {
		return "", err
	}
	if ep, ok := eps[pub]; ok {
		return ep, nil
	}
	return "", errors.New("no address for that peer yet")
}
