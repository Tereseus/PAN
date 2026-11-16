package link

// Meeting in the middle (docs/INSTALL-PLAN.md, reach order 4): how a device away from
// home reaches a hub whose router and provider let nothing in, with no relay, no Tailscale
// account and nothing hosted by PAN.
//
// Such a home lets a packet in only from an address it has itself sent to (stun.go has
// the measurement). So:
//
//  1. Both sides learn their own outside address from free public STUN servers, asked
//     from WireGuard's own socket (STUNBind).
//  2. The hub's outside address goes into the address record it already publishes
//     (record.go), so the device knows where to send its handshakes.
//  3. The device tells the hub its outside address: through the tunnel when any path is
//     up (over Tailscale, say, to move to a direct path), otherwise in a small record of
//     its own on the same public relays, which the hub looks up for devices it has lost.
//  4. The hub sends punch packets to the device's address. They open the home's router
//     and provider for that device, and its next handshake gets in.
//
// A device's record is signed and sealed with keys made from the pair secret: the
// Diffie-Hellman result of the device's and the hub's WireGuard keys, which only those two
// know. So the hub knows where to look without being told, nobody else can read or write
// the record, and it goes on working when another device is removed. (The first version
// used the hub's record secret, which changes on every removal: each removal would have
// locked every device that was away out until it came home.) Removing a device removes
// its WireGuard key from the hub, and the hub then never looks for its record again.
//
// The hub answers the same way. When it finds a lost device's record it leaves its own
// addresses in a second record made from the same pair secret (PublishReply), which the
// device reads when the hub's shared address record does not open any more (FindHubReply):
// that happens to a device that was away while another one was removed.
//
// It cannot work over IPv4 for a device whose network shows a different port to every
// destination (the hard kind): the hub has nothing to aim at. That device gets in over
// IPv6 when both ends have it, and otherwise only at home.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/curve25519"
)

var (
	// punchFor is how long the hub keeps sending punch packets after it learns a device's
	// outside address: several of the device's 5 s handshake tries.
	punchFor = 40 * time.Second
	// offlineAfter: a device sends a keepalive every KeepaliveSec; nothing for this long
	// means it is gone and the hub starts looking for its record.
	offlineAfter = 45 * time.Second
	// outsideOK says whether an address can be an outside address at all (tests, which
	// run on 127.0.0.1, replace it).
	outsideOK = func(ip netip.Addr) bool { return ip.IsGlobalUnicast() && !ip.IsPrivate() && !IsTailnet(ip) }
)

// maxOutside is the most outside addresses a device may report.
const maxOutside = 4

// lookupEvery is how often the hub looks for the record of a device it lost: often at
// first, when the person has just walked out of the door, rarely for one that has been
// off for a day. The relays are a free public service.
var lookupEvery = func(gone time.Duration) time.Duration {
	switch {
	case gone < 10*time.Minute:
		return 5 * time.Second
	case gone < time.Hour:
		return 15 * time.Second
	case gone < 24*time.Hour:
		return 2 * time.Minute
	}
	return 10 * time.Minute
}

// pairSecret is what one device and its hub alone know: the Diffie-Hellman result of
// their two WireGuard keys (priv is one side's private key, peerPub the other's public
// key). It stays the same for as long as the device is paired.
func pairSecret(priv, peerPub string) ([]byte, error) {
	k, err := keyBytes(priv)
	if err != nil {
		return nil, err
	}
	p, err := keyBytes(peerPub)
	if err != nil {
		return nil, err
	}
	return curve25519.X25519(k, p)
}

// pairKeys makes, from the pair secret, the key that signs one of the pair's two records
// and the key that seals it. what is "device" (the device's outside addresses, for the
// hub) or "hub" (the hub's addresses, for that device).
func pairKeys(shared []byte, what string) (ed25519.PrivateKey, []byte) {
	sum := func(use string) []byte {
		h := sha256.New()
		h.Write([]byte("pan-link pair record v2\x00" + what + "\x00" + use + "\x00"))
		h.Write(shared)
		return h.Sum(nil)
	}
	return ed25519.NewKeyFromSeed(sum("sign")), sum("seal")
}

// putPairRecord seals addrs and puts them on the relays; one relay taking it is enough.
func putPairRecord(ctx context.Context, priv ed25519.PrivateKey, seal []byte, addrs, relays []string, hc *http.Client) error {
	pkt, _, err := sealAddresses(seal, addrs)
	if err != nil {
		return err
	}
	if relays == nil {
		relays = DefaultRelays
	}
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	body := signRecord(priv, uint64(time.Now().UnixMicro()), pkt)
	z := zbase32(priv.Public().(ed25519.PublicKey))
	errs := make(chan error, len(relays))
	for _, r := range relays {
		go func(r string) { errs <- relayPut(ctx, hc, r, z, body) }(r)
	}
	var firstErr error
	for range relays {
		if err := <-errs; err == nil {
			return nil
		} else if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// getPairRecord looks a pair record up, one relay after another, and returns its
// addresses and sequence number.
func getPairRecord(ctx context.Context, priv ed25519.PrivateKey, seal []byte, relays []string, hc *http.Client) ([]string, uint64, error) {
	pub := priv.Public().(ed25519.PublicKey)
	if relays == nil {
		relays = DefaultRelays
	}
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	var firstErr error
	for _, r := range relays {
		body, err := relayGet(ctx, hc, r, zbase32(pub))
		if err == nil {
			var seq uint64
			var v []byte
			if seq, v, err = verifyRecord(pub, body); err == nil {
				var addrs []string
				if addrs, err = openAddresses(seal, v); err == nil {
					return addrs, seq, nil
				}
			}
		}
		if firstErr == nil || errors.Is(firstErr, ErrNoRecord) {
			firstErr = err
		}
	}
	return nil, 0, firstErr
}

func cleanOutside(addrs []string) []string {
	var out []string
	for _, a := range addrs {
		ap, err := netip.ParseAddrPort(strings.TrimSpace(a))
		if err != nil || ap.Port() == 0 || len(out) >= maxOutside {
			continue
		}
		ip := ap.Addr().Unmap()
		if !outsideOK(ip) {
			continue
		}
		out = append(out, netip.AddrPortFrom(ip, ap.Port()).String())
	}
	return out
}

// PublishOutside puts the device's outside addresses on the relays for its hub to find.
// One relay taking it is enough.
func PublishOutside(ctx context.Context, st *ClientState, addrs []string, relays []string, hc *http.Client) error {
	addrs = cleanOutside(addrs)
	if len(addrs) == 0 {
		return errors.New("no outside address to publish")
	}
	shared, err := pairSecret(st.PrivateKey, st.HubKey)
	if err != nil {
		return err
	}
	priv, seal := pairKeys(shared, "device")
	if err := putPairRecord(ctx, priv, seal, addrs, relays, hc); err != nil {
		return fmt.Errorf("no relay took the device's address: %w", err)
	}
	return nil
}

// FindHubReply reads the hub's addresses from the record the hub leaves for this device
// alone (Hub.PublishReply). It still opens after another device was removed, when the
// hub's shared record (FindHub) does not.
func FindHubReply(ctx context.Context, st *ClientState, relays []string, hc *http.Client) ([]string, error) {
	shared, err := pairSecret(st.PrivateKey, st.HubKey)
	if err != nil {
		return nil, err
	}
	priv, seal := pairKeys(shared, "hub")
	addrs, _, err := getPairRecord(ctx, priv, seal, relays, hc)
	return addrs, err
}

// TellHubOutside sends the device's outside addresses to the hub through the tunnel, on
// whatever path is up. The hub starts punching toward them at once and answers with its
// own current addresses (none from a hub older than 2026-11-15), which is where the
// device's next handshake has to go.
func TellHubOutside(ctx context.Context, l *Link, st *ClientState, addrs []string) ([]string, error) {
	body, _ := json.Marshal(map[string]any{"addrs": cleanOutside(addrs)})
	req, _ := http.NewRequestWithContext(ctx, "POST", hubURL(st.HubIP, "/.pan-link/outside"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := tunnelClient(l, 8*time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("hub answered %d", resp.StatusCode)
	}
	var out struct {
		Hub []string `json:"hub"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&out)
	if len(out.Hub) > 16 {
		out.Hub = out.Hub[:16]
	}
	return out.Hub, nil
}

// devicePunch is what the hub knows about reaching one device from outside.
type devicePunch struct {
	rx       uint64    // bytes received from it, as last read
	rxAt     time.Time // when that last grew
	addrs    []string  // its outside addresses, newest
	until    time.Time // punch toward addrs until then
	seq      uint64    // newest record used
	lookupAt time.Time // last record lookup
	looking  bool      // a lookup is running
	replyKey string    // the hub addresses last left for it (PublishReply)
	replyAt  time.Time // when
}

type punchBook struct {
	mu      sync.Mutex
	started time.Time
	devs    map[string]*devicePunch // by device id
}

func (b *punchBook) get(id string, now time.Time) *devicePunch {
	if b.devs == nil {
		b.devs = map[string]*devicePunch{}
		b.started = now
	}
	p := b.devs[id]
	if p == nil {
		p = &devicePunch{rxAt: b.started}
		b.devs[id] = p
	}
	return p
}

// NoteOutside records a device's outside addresses and punches toward them now.
func (h *Hub) NoteOutside(d Device, addrs []string) int {
	addrs = cleanOutside(addrs)
	if len(addrs) == 0 {
		return 0
	}
	now := h.now()
	h.punch.mu.Lock()
	p := h.punch.get(d.ID, now)
	p.addrs, p.until = addrs, now.Add(punchFor)
	h.punch.mu.Unlock()
	return h.link.Punch(addrs)
}

// FindDevice looks a device's outside-address record up on the relays, one relay after
// another, and returns its addresses and sequence number.
func (h *Hub) FindDevice(ctx context.Context, d Device) ([]string, uint64, error) {
	h.mu.Lock()
	hubPriv := h.state.PrivateKey
	h.mu.Unlock()
	shared, err := pairSecret(hubPriv, d.PublicKey)
	if err != nil {
		return nil, 0, err
	}
	priv, seal := pairKeys(shared, "device")
	addrs, seq, err := getPairRecord(ctx, priv, seal, h.Relays, h.relayClient())
	if err != nil {
		return nil, 0, err
	}
	return cleanOutside(addrs), seq, nil
}

// replyEvery is how often the hub leaves its addresses again for a device that is still
// looking, when they have not changed.
var replyEvery = 10 * time.Minute

// PublishReply leaves the hub's current addresses on the relays for one device alone,
// sealed with the pair secret. PunchTick calls it when it finds that device's record: the
// device is away and looking for the hub, and may hold an old key for the shared record.
// It reports whether it published (not when the same addresses went out lately).
func (h *Hub) PublishReply(ctx context.Context, d Device) (bool, error) {
	if h.Endpoints == nil {
		return false, nil
	}
	addrs := h.Endpoints()
	if len(addrs) == 0 {
		return false, nil
	}
	key := strings.Join(addrs, ",")
	now := h.now()
	h.punch.mu.Lock()
	p := h.punch.get(d.ID, now)
	if key == p.replyKey && now.Sub(p.replyAt) < replyEvery {
		h.punch.mu.Unlock()
		return false, nil
	}
	old, oldAt := p.replyKey, p.replyAt
	p.replyKey, p.replyAt = key, now // taken now, so two lookups do not both publish
	h.punch.mu.Unlock()
	h.mu.Lock()
	hubPriv := h.state.PrivateKey
	h.mu.Unlock()
	shared, err := pairSecret(hubPriv, d.PublicKey)
	if err == nil {
		priv, seal := pairKeys(shared, "hub")
		err = putPairRecord(ctx, priv, seal, addrs, h.Relays, h.relayClient())
	}
	if err != nil {
		h.punch.mu.Lock()
		p.replyKey, p.replyAt = old, oldAt
		h.punch.mu.Unlock()
		return false, err
	}
	return true, nil
}

// PunchTick is the hub's side of meeting in the middle; the program calls it every 2 s.
// It punches toward devices whose outside address it learned lately, and looks for the
// record of each device it has lost.
func (h *Hub) PunchTick(ctx context.Context) {
	now := h.now()
	rx, _ := h.link.peerRx()
	for _, d := range h.Devices() {
		pub, err := keyHex(d.PublicKey)
		if err != nil {
			continue
		}
		h.punch.mu.Lock()
		p := h.punch.get(d.ID, now)
		if n := rx[pub]; n != p.rx {
			p.rx, p.rxAt = n, now
		}
		gone := now.Sub(p.rxAt)
		var punchTo []string
		if now.Before(p.until) {
			if gone < offlineAfter && now.Sub(p.until.Add(-punchFor)) > 6*time.Second {
				p.until = time.Time{} // it is talking to us again: done
			} else {
				punchTo = p.addrs
			}
		}
		look := gone >= offlineAfter && !p.looking && now.Sub(p.lookupAt) >= lookupEvery(gone)
		if look {
			p.looking, p.lookupAt = true, now
		}
		h.punch.mu.Unlock()
		if len(punchTo) > 0 {
			h.link.Punch(punchTo)
		}
		if !look {
			continue
		}
		go func(d Device) {
			lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			addrs, seq, err := h.FindDevice(lctx, d)
			cancel()
			h.punch.mu.Lock()
			p := h.punch.get(d.ID, h.now())
			p.looking = false
			fresh := err == nil && seq > p.seq && len(addrs) > 0
			if fresh {
				p.seq, p.addrs, p.until = seq, addrs, h.now().Add(punchFor)
			}
			h.punch.mu.Unlock()
			if fresh {
				h.link.Punch(addrs)
				if h.OnPunch != nil {
					h.OnPunch(d, addrs)
				}
				rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
				h.PublishReply(rctx, d)
				cancel()
			}
		}(d)
	}
}

// peerRx maps each peer's public key (hex) to the bytes received from it.
func (l *Link) peerRx() (map[string]uint64, error) {
	conf, err := l.dev.IpcGet()
	if err != nil {
		return nil, err
	}
	out := map[string]uint64{}
	cur := ""
	for _, line := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(line, "public_key="); ok {
			cur = v
			continue
		}
		if v, ok := strings.CutPrefix(line, "rx_bytes="); ok && cur != "" {
			var n uint64
			fmt.Sscanf(v, "%d", &n)
			out[cur] = n
		}
	}
	return out, nil
}

// Meeter is the device's side of meeting in the middle. Call Tick every few seconds, and
// once right after a network change.
type Meeter struct {
	Link   *Link
	State  func() ClientState // the pairing as it is now
	Relays []string           // nil: the public relays
	HC     *http.Client       // nil: a client with a 20 s limit
	Log    func(string)       // nil: silent

	mu        sync.Mutex
	probeAt   time.Time
	toldKey   string
	toldAt    time.Time
	toldN     int
	pubKey    string
	pubAt     time.Time
	pubBusy   bool
	findAt    time.Time
	findBusy  bool
	findMiss  bool      // the last lookup brought no hub address
	seekAt    time.Time // since when there has been no path to the hub
	replyUsed bool
	lastState string
}

// findEvery is how often a device with no path looks for the hub's addresses: soon again
// after a miss in the first minutes (the hub answers a device it has just found, which
// takes a few seconds), rarely once it has been cut off for an hour. publishEvery is the
// same for leaving its own address again when that has not changed. The relays are a free
// public service.
var (
	findEvery = func(seeking time.Duration, missed bool) time.Duration {
		switch {
		case seeking > time.Hour:
			return 5 * time.Minute
		case missed && seeking < 3*time.Minute:
			return 8 * time.Second
		}
		return 30 * time.Second
	}
	publishEvery = func(seeking time.Duration) time.Duration {
		if seeking > time.Hour {
			return 10 * time.Minute
		}
		return 90 * time.Second
	}
)

func (m *Meeter) logf(format string, args ...any) {
	if m.Log != nil {
		m.Log(fmt.Sprintf(format, args...))
	}
}

// NetworkChanged forgets what was told and published, so the next Tick starts over on
// the new network.
func (m *Meeter) NetworkChanged() {
	m.mu.Lock()
	m.probeAt, m.toldKey, m.toldN, m.pubKey, m.findAt, m.replyUsed = time.Time{}, "", 0, "", time.Time{}, false
	m.seekAt, m.findMiss = time.Time{}, false
	m.mu.Unlock()
}

// Tick does one round. connected says whether the hub answered lately; path is the kind
// of hub address in use ("local", "internet", "tailscale" or ""). found is called with the
// hub's addresses from its record when a lookup brought new ones (to save the pairing).
func (m *Meeter) Tick(ctx context.Context, connected bool, path string, found func(addrs []string, seq uint64, added int)) {
	if m.Link == nil {
		return
	}
	now := time.Now()
	m.mu.Lock()
	if connected {
		m.seekAt, m.findMiss = time.Time{}, false
	} else if m.seekAt.IsZero() {
		m.seekAt = now
	}
	seeking := now.Sub(m.seekAt)
	m.mu.Unlock()
	if connected && (path == "local" || path == "internet") {
		return // a direct path is up: nothing to arrange
	}
	st := m.State()
	m.mu.Lock()
	probe := now.Sub(m.probeAt) >= 20*time.Second
	if probe {
		m.probeAt = now
	}
	m.mu.Unlock()
	if probe {
		if err := m.Link.ProbeOutside(ctx); err != nil {
			m.logf("address check: %v", err)
		}
	}
	o := m.Link.Outside()
	addrs := o.Strings()
	key := strings.Join(addrs, ",")
	state := fmt.Sprintf("outside %s hard=%v", key, o.Hard)
	m.mu.Lock()
	if o.Servers > 0 && state != m.lastState {
		m.lastState = state
		m.mu.Unlock()
		m.logf("%s", state)
		m.mu.Lock()
	}
	m.mu.Unlock()

	if connected { // over Tailscale: ask the hub to open a direct path, then try it
		if len(addrs) == 0 {
			return
		}
		m.mu.Lock()
		// Again each minute for a while, then rarely: a network of the hard kind on either
		// side never gets a direct path, and Tailscale goes on carrying the link.
		every := time.Minute
		if m.toldN >= 5 {
			every = 10 * time.Minute
		}
		tell := key != m.toldKey || now.Sub(m.toldAt) >= every
		if tell {
			if key != m.toldKey {
				m.toldN = 0
			}
			m.toldKey, m.toldAt, m.toldN = key, now, m.toldN+1
		}
		m.mu.Unlock()
		if !tell {
			return
		}
		go func() {
			tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			hubAddrs, err := TellHubOutside(tctx, m.Link, &st, addrs)
			if err != nil {
				m.logf("telling the hub our outside address: %v", err)
				return
			}
			// The hub is punching toward us now; a handshake to its direct addresses can get
			// in. They are the ones it just sent: this device may only know old ones.
			if len(hubAddrs) > 0 {
				n := m.Link.AddHubAddresses(tctx, st.HubKey, hubAddrs)
				if n > 0 {
					m.logf("the hub told us %d new addresses of its own", n)
					if found != nil {
						found(hubAddrs, st.RecordSeq, n)
					}
				}
			}
			time.Sleep(300 * time.Millisecond)
			m.Link.Rehandshake(st.HubKey)
		}()
		return
	}

	// Not connected: leave our address where the hub looks, find the hub's, keep knocking.
	if st.HubKey != "" && len(addrs) > 0 {
		m.mu.Lock()
		pub := !m.pubBusy && (key != m.pubKey || now.Sub(m.pubAt) >= publishEvery(seeking))
		if pub {
			m.pubBusy = true
		}
		m.mu.Unlock()
		if pub {
			go func() {
				pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
				err := PublishOutside(pctx, &st, addrs, m.Relays, m.HC)
				cancel()
				m.mu.Lock()
				m.pubBusy = false
				if err == nil {
					m.pubKey, m.pubAt = key, time.Now()
				}
				m.mu.Unlock()
				if err != nil {
					m.logf("publishing our outside address: %v", err)
				} else {
					m.logf("published our outside address for the hub (%s)", key)
				}
			}()
		}
	}
	if st.HubKey != "" {
		m.mu.Lock()
		find := !m.findBusy && now.Sub(m.findAt) >= findEvery(seeking, m.findMiss)
		if find {
			m.findBusy, m.findAt = true, now
		}
		m.mu.Unlock()
		if find {
			go func() {
				fctx, cancel := context.WithTimeout(ctx, 20*time.Second)
				defer cancel()
				missed := true
				defer func() {
					m.mu.Lock()
					m.findBusy, m.findMiss = false, missed
					m.mu.Unlock()
				}()
				hubAddrs, seq, err := FindHub(fctx, &st, m.Relays, m.HC)
				if err != nil {
					// The shared record does not open (a device was removed while this one was
					// away) or is not there: read what the hub left for this device alone.
					if hubAddrs, err = FindHubReply(fctx, &st, m.Relays, m.HC); err != nil || len(hubAddrs) == 0 {
						return
					}
					seq = st.RecordSeq
					m.mu.Lock()
					first := !m.replyUsed
					m.replyUsed = true
					m.mu.Unlock()
					if first {
						m.logf("the hub's addresses came from its answer to this device")
					}
				}
				missed = false
				n := m.Link.AddHubAddresses(fctx, st.HubKey, hubAddrs)
				if found != nil {
					found(hubAddrs, seq, n)
				}
			}()
		}
	}
	m.Link.Rehandshake(st.HubKey)
}

// PathOf says what kind of path a hub address is: "local" (the home network), "tailscale"
// or "internet". Empty for no address.
func PathOf(addr string) string {
	ap, err := netip.ParseAddrPort(addr)
	if err != nil {
		return ""
	}
	ip := ap.Addr().Unmap()
	switch {
	case IsTailnet(ip):
		return "tailscale"
	case ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLoopback():
		return "local"
	}
	return "internet"
}

// outsideKinds says whether a list of hub addresses holds an IPv6 and an IPv4 address a
// device away from home can aim at.
func outsideKinds(addrs []string) (v6, v4 bool) {
	for _, a := range addrs {
		ap, err := netip.ParseAddrPort(a)
		if err != nil {
			continue
		}
		ip := ap.Addr().Unmap()
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || IsTailnet(ip) {
			continue
		}
		if ip.Is6() {
			v6 = true
		} else {
			v4 = true
		}
	}
	return v6, v4
}

// ReachWords says in plain words whether devices can reach this hub from outside the home
// (for PAN's pairing page and PAN Setup). endpoints is the hub's address list: a public
// IPv4 address in it that the STUN servers did not report is an open port (a router
// forward, or a public address on the computer itself), which every network can reach.
func ReachWords(o OutsideAddrs, endpoints []string) string {
	open := false
	for _, a := range endpoints {
		if ap, err := netip.ParseAddrPort(a); err == nil {
			ip := ap.Addr().Unmap()
			if ip.Is4() && ip.IsGlobalUnicast() && !ip.IsPrivate() && !IsTailnet(ip) && ap != o.V4 {
				open = true
			}
		}
	}
	v6, v4 := o.V6.IsValid(), o.AimV4()
	switch {
	case open:
		return "Phones can reach this computer from outside your home on any network."
	case o.Servers == 0:
		return "Not checked yet whether phones can reach this computer from outside your home."
	case v6 && v4:
		return "Phones can reach this computer from outside your home on most networks, with nothing to set up."
	case v6:
		return "Phones can reach this computer from outside your home when their network has IPv6, which most mobile networks do."
	case v4:
		return "Phones can reach this computer from outside your home on most Wi-Fi networks. Some mobile networks will not get through."
	}
	return "This home's internet connection lets nothing in from outside, so PAN works on your home network only."
}

// AwayWords says in plain words how a device stands with its hub (for the app's screens).
// hubAddrs is the hub's address list as the device has it.
func AwayWords(connected bool, path string, o OutsideAddrs, hubAddrs []string) string {
	if connected {
		switch path {
		case "local":
			return "On your home network."
		case "internet":
			return "Connected directly from outside your home."
		case "tailscale":
			return "Connected through the backup route."
		}
		return "Connected."
	}
	if o.Servers == 0 {
		return "Not reaching your PAN computer yet. Checking this network." // no STUN answer (yet, or no internet)
	}
	hub6, hub4 := outsideKinds(hubAddrs)
	if (hub6 && o.V6.IsValid()) || (hub4 && o.AimV4()) {
		return "Finding a direct way to your PAN computer."
	}
	if o.V4.IsValid() && !o.Hard && !o.Sure {
		return "Checking this network." // one server answered so far: easy or hard is not known yet
	}
	return "This network cannot reach your PAN computer directly. PAN works again on your home Wi-Fi or on another network."
}
