package link

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/tailscale/wireguard-go/conn"
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

// sprayBind sends every packet to all of the hub's known addresses until the tunnel
// works. Whichever address the hub answers on first wins, so a phone away from home
// does not wait on each dead home address in turn. After settle, packets go only to
// the address WireGuard learned from the hub's answers.
type sprayBind struct {
	conn.Bind
	cands []string

	mu      sync.Mutex
	eps     []conn.Endpoint // cands, parsed by the inner bind when it opens
	settled atomic.Bool
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
	s.mu.Unlock()
	if s.settled.Load() || len(eps) == 0 {
		return s.Bind.Send(bufs, ep, offset)
	}
	var firstErr error
	sent := false
	for _, e := range eps {
		// Each address gets its own copy: a batching bind may write into the buffers.
		cp := make([][]byte, len(bufs))
		for i, b := range bufs {
			cp[i] = append([]byte(nil), b...)
		}
		if err := s.Bind.Send(cp, e, offset); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		sent = true
	}
	if sent {
		return nil // an address that can't be sent to (no IPv6 here, say) is not an error
	}
	return firstErr
}

// settle stops the spraying.
func (s *sprayBind) settle() { s.settled.Store(true) }

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
	return l, sb, nil
}

// PeerEndpoint is the address WireGuard currently uses for a peer. It follows the
// peer's real address from the packets it sends (roaming).
func (l *Link) PeerEndpoint(publicKey string) (string, error) {
	pub, err := keyHex(publicKey)
	if err != nil {
		return "", err
	}
	conf, err := l.dev.IpcGet()
	if err != nil {
		return "", err
	}
	in := false
	for _, line := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(line, "public_key="); ok {
			in = v == pub
			continue
		}
		if v, ok := strings.CutPrefix(line, "endpoint="); ok && in {
			return v, nil
		}
	}
	return "", errors.New("no address for that peer yet")
}
