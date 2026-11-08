package link

// The hub's address record: the addresses devices can reach the hub on, encrypted and
// signed with a key of the hub's own, published on Pkarr (signed records on the public
// Mainline DHT, reached through Pkarr's free HTTP relays). A paired device that can't
// reach the hub on any saved address (the home's public address changed, the hub got a
// new home network address) looks the record up and tries the addresses in it.
//
// Nobody can forge the record (it is signed), and nobody but a paired device can read it
// (only they get its key, through the tunnel). The worst a relay can do is not answer,
// or answer with an older record, which devices refuse. With no paired device the hub
// publishes nothing. Removing a device changes the encryption key, so a lost phone can't
// follow the hub's addresses afterwards.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

// DefaultRelays are Pkarr's public relays. Each stores a record on the Mainline DHT and
// reads records back from there, so any one of them answering is enough.
var DefaultRelays = []string{"https://relay.pkarr.org", "https://pkarr.pubky.org", "https://pkarr.pubky.app"}

// RecordRefresh is how often the hub publishes its record again when nothing changed.
// DHT nodes drop a record after about two hours.
var RecordRefresh = time.Hour

const (
	maxSignedValue = 1000 // BEP44's limit on a record's value (the DNS packet)
	recordLabel    = "_pan"
	recordVersion  = "pan=1"
	relayType      = "application/pkarr.org/relays#payload"
)

// ErrNoRecord means no relay had a record for the hub.
var ErrNoRecord = errors.New("no address record for this hub")

// RecordInfo is what a paired device needs to find and read the hub's address record.
// The hub gives it out through the tunnel only.
type RecordInfo struct {
	Key    string `json:"key"`    // the record's Ed25519 public key, base64
	Secret string `json:"secret"` // its encryption key, base64 (32 bytes)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func newRecordSecret() string {
	return base64.StdEncoding.EncodeToString(randomBytes(chacha20poly1305.KeySize))
}

// ensureRecordKeys gives the state the record's signing and encryption keys if it has
// none (a hub set up before records existed). It reports whether it changed anything.
func (st *HubState) ensureRecordKeys() bool {
	changed := false
	if seed, err := base64.StdEncoding.DecodeString(st.RecordSeed); err != nil || len(seed) != ed25519.SeedSize {
		st.RecordSeed = base64.StdEncoding.EncodeToString(randomBytes(ed25519.SeedSize))
		changed = true
	}
	if k, err := base64.StdEncoding.DecodeString(st.RecordSecret); err != nil || len(k) != chacha20poly1305.KeySize {
		st.RecordSecret = newRecordSecret()
		changed = true
	}
	return changed
}

func (st *HubState) recordKeys() (ed25519.PrivateKey, []byte, error) {
	seed, err := base64.StdEncoding.DecodeString(st.RecordSeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, nil, errors.New("hub has no address record key")
	}
	secret, err := base64.StdEncoding.DecodeString(st.RecordSecret)
	if err != nil || len(secret) != chacha20poly1305.KeySize {
		return nil, nil, errors.New("hub has no address record secret")
	}
	return ed25519.NewKeyFromSeed(seed), secret, nil
}

// RecordInfo is the record's public key and encryption key, for paired devices.
func (h *Hub) RecordInfo() RecordInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	priv, _, err := h.state.recordKeys()
	if err != nil {
		return RecordInfo{}
	}
	return RecordInfo{
		Key:    base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)),
		Secret: h.state.RecordSecret,
	}
}

// PublishAddresses puts the hub's current addresses (Endpoints) on the relays, when they
// changed or the last copy is RecordRefresh old. It reports whether it published. With
// no paired device there is nobody to read a record, so it publishes nothing. One relay
// taking the record is enough; the program calls this every minute or so.
func (h *Hub) PublishAddresses(ctx context.Context) (bool, error) {
	h.recMu.Lock()
	defer h.recMu.Unlock()
	if len(h.Devices()) == 0 {
		return false, nil
	}
	addrs := h.Endpoints()
	if len(addrs) == 0 {
		return false, nil
	}
	h.mu.Lock()
	priv, secret, err := h.state.recordKeys()
	key := h.state.RecordSecret + "|" + strings.Join(addrs, ",")
	h.mu.Unlock()
	if err != nil {
		return false, err
	}
	now := h.now()
	if key == h.recLast && now.Sub(h.recAt) < RecordRefresh {
		return false, nil
	}
	pkt, n, err := sealAddresses(secret, addrs)
	if err != nil {
		return false, err
	}
	// The sequence number is the time in microseconds, as Pkarr has it. Never go back,
	// even if the clock does: relays and devices refuse an older record.
	seq := uint64(now.UnixMicro())
	if seq <= h.recSeq {
		seq = h.recSeq + 1
	}
	body := signRecord(priv, seq, pkt)
	z := zbase32(priv.Public().(ed25519.PublicKey))
	relays := h.Relays
	if relays == nil {
		relays = DefaultRelays
	}
	errs := make(chan error, len(relays))
	for _, r := range relays {
		go func(r string) { errs <- relayPut(ctx, h.relayClient(), r, z, body) }(r)
	}
	var firstErr error
	for range relays {
		err := <-errs
		if err == nil {
			h.recLast, h.recAt, h.recSeq, h.recCount = key, now, seq, n
			return true, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return false, fmt.Errorf("no relay took the address record: %w", firstErr)
}

// PublishedAddresses says how many addresses the last published record held (they are
// cut from the end when they don't all fit) and when it went out.
func (h *Hub) PublishedAddresses() (int, time.Time) {
	h.recMu.Lock()
	defer h.recMu.Unlock()
	return h.recCount, h.recAt
}

func (h *Hub) relayClient() *http.Client {
	if h.RelayClient != nil {
		return h.RelayClient
	}
	return &http.Client{Timeout: 20 * time.Second}
}

// FetchRecordInfo asks the hub, through the link, for its address record's keys and puts
// them in st. It reports whether they changed (st then needs saving): they change when
// the hub removed a device. A device calls it now and then while connected.
func FetchRecordInfo(ctx context.Context, l *Link, st *ClientState) (bool, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", hubURL(st.HubIP, "/.pan-link/record"), nil)
	resp, err := tunnelClient(l, 10*time.Second).Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("hub answered %d", resp.StatusCode)
	}
	var info RecordInfo
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&info); err != nil {
		return false, err
	}
	return st.setRecordInfo(info)
}

// setRecordInfo stores record keys after checking them. Reports a change.
func (st *ClientState) setRecordInfo(info RecordInfo) (bool, error) {
	if pub, err := base64.StdEncoding.DecodeString(info.Key); err != nil || len(pub) != ed25519.PublicKeySize {
		return false, errors.New("hub sent a bad address record key")
	}
	if k, err := base64.StdEncoding.DecodeString(info.Secret); err != nil || len(k) != chacha20poly1305.KeySize {
		return false, errors.New("hub sent a bad address record secret")
	}
	if info.Key == st.RecordKey && info.Secret == st.RecordSecret {
		return false, nil
	}
	if info.Key != st.RecordKey {
		st.RecordSeq = 0 // a new record key starts its own sequence
	}
	st.RecordKey, st.RecordSecret = info.Key, info.Secret
	return true, nil
}

// FindHub looks the hub's address record up on the relays and returns its addresses, best
// first, with the record's sequence number. It asks every relay at once and takes the
// newest record that checks out; one older than the newest this device has used
// (st.RecordSeq) is refused. Give ctx a time limit: a relay may not answer at all.
func FindHub(ctx context.Context, st *ClientState, relays []string, hc *http.Client) ([]string, uint64, error) {
	pub, err := base64.StdEncoding.DecodeString(st.RecordKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return nil, 0, errors.New("this pairing has no address record key yet")
	}
	secret, err := base64.StdEncoding.DecodeString(st.RecordSecret)
	if err != nil || len(secret) != chacha20poly1305.KeySize {
		return nil, 0, errors.New("this pairing has no address record secret yet")
	}
	if relays == nil {
		relays = DefaultRelays
	}
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	z := zbase32(pub)
	type result struct {
		addrs []string
		seq   uint64
		err   error
	}
	ch := make(chan result, len(relays))
	for _, r := range relays {
		go func(r string) {
			body, err := relayGet(ctx, hc, r, z)
			if err != nil {
				ch <- result{err: err}
				return
			}
			seq, v, err := verifyRecord(pub, body)
			if err != nil {
				ch <- result{err: fmt.Errorf("%s: %w", r, err)}
				return
			}
			addrs, err := openAddresses(secret, v)
			ch <- result{addrs: addrs, seq: seq, err: err}
		}(r)
	}
	var best result
	var firstErr error
	for range relays {
		r := <-ch
		switch {
		case r.err != nil:
			if firstErr == nil || errors.Is(firstErr, ErrNoRecord) {
				firstErr = r.err
			}
		case best.addrs == nil || r.seq > best.seq:
			best = r
		}
	}
	if best.addrs == nil {
		return nil, 0, firstErr
	}
	if best.seq < st.RecordSeq {
		return nil, 0, errors.New("the relays only have an older address record")
	}
	return best.addrs, best.seq, nil
}

// AddHubAddresses adds hub addresses the link didn't have (from the address record) to
// the ones each handshake goes to, and starts a handshake when any were new. It returns
// how many were new.
func (l *Link) AddHubAddresses(ctx context.Context, hubKey string, addrs []string) int {
	if l.spray == nil {
		return 0
	}
	n := l.spray.add(resolveEndpoints(ctx, addrs))
	if n > 0 {
		l.Rehandshake(hubKey)
	}
	return n
}

// sealAddresses encrypts the addresses with the record secret and returns the DNS packet
// that carries them: one TXT answer at _pan holding "pan=1" and then the sealed bytes in
// base64 pieces. Addresses that don't fit in BEP44's 1000 bytes are cut from the end (the
// list is best first). It returns the packet and how many addresses are in it.
func sealAddresses(secret []byte, addrs []string) ([]byte, int, error) {
	aead, err := chacha20poly1305.NewX(secret)
	if err != nil {
		return nil, 0, err
	}
	for n := len(addrs); n > 0; n-- {
		nonce := randomBytes(aead.NonceSize())
		sealed := aead.Seal(nonce, nonce, []byte(strings.Join(addrs[:n], ",")), []byte(recordVersion))
		pkt := txtPacket(recordLabel, recordVersion, base64.RawURLEncoding.EncodeToString(sealed))
		if len(pkt) <= maxSignedValue {
			return pkt, n, nil
		}
	}
	return nil, 0, errors.New("no address fits in a record")
}

// openAddresses reads what sealAddresses wrote.
func openAddresses(secret, pkt []byte) ([]string, error) {
	strs, err := txtStrings(pkt, recordLabel)
	if err != nil {
		return nil, err
	}
	if len(strs) < 2 || !strings.HasPrefix(strs[0], "pan=") {
		return nil, errors.New("not a PAN Link address record")
	}
	if strs[0] != recordVersion {
		return nil, errors.New("address record from a newer pan-link")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(strings.Join(strs[1:], ""))
	if err != nil {
		return nil, errors.New("damaged address record")
	}
	aead, err := chacha20poly1305.NewX(secret)
	if err != nil {
		return nil, err
	}
	if len(sealed) < aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("damaged address record")
	}
	plain, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte(recordVersion))
	if err != nil {
		return nil, errors.New("the address record doesn't open with this pairing's key (a device was removed since; reconnect once to get the new key)")
	}
	var out []string
	for _, a := range strings.Split(string(plain), ",") {
		if _, _, err := net.SplitHostPort(a); err != nil {
			return nil, fmt.Errorf("bad address %q in the record", a)
		}
		out = append(out, a)
	}
	return out, nil
}

// signable is what BEP44 signs for a mutable item without salt.
func signable(seq uint64, v []byte) []byte {
	return append([]byte("3:seqi"+strconv.FormatUint(seq, 10)+"e1:v"+strconv.Itoa(len(v))+":"), v...)
}

// signRecord makes what a Pkarr relay stores: signature, sequence number (big-endian),
// then the DNS packet.
func signRecord(priv ed25519.PrivateKey, seq uint64, v []byte) []byte {
	out := make([]byte, 0, ed25519.SignatureSize+8+len(v))
	out = append(out, ed25519.Sign(priv, signable(seq, v))...)
	out = binary.BigEndian.AppendUint64(out, seq)
	return append(out, v...)
}

func verifyRecord(pub ed25519.PublicKey, body []byte) (uint64, []byte, error) {
	if len(body) < ed25519.SignatureSize+8 || len(body) > ed25519.SignatureSize+8+maxSignedValue {
		return 0, nil, errors.New("address record has the wrong size")
	}
	sig, seq, v := body[:ed25519.SignatureSize], binary.BigEndian.Uint64(body[ed25519.SignatureSize:]), body[ed25519.SignatureSize+8:]
	if !ed25519.Verify(pub, signable(seq, v), sig) {
		return 0, nil, errors.New("address record signature doesn't match the hub's key")
	}
	return seq, v, nil
}

func relayPut(ctx context.Context, hc *http.Client, relay, z string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, "PUT", strings.TrimRight(relay, "/")+"/"+z, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", relayType)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK {
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	return fmt.Errorf("%s answered %d %s", relay, resp.StatusCode, bytes.TrimSpace(msg))
}

func relayGet(ctx context.Context, hc *http.Client, relay, z string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(relay, "/")+"/"+z, nil)
	if err != nil {
		return nil, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return io.ReadAll(io.LimitReader(resp.Body, ed25519.SignatureSize+8+maxSignedValue+1))
	case http.StatusNotFound:
		return nil, ErrNoRecord
	}
	return nil, fmt.Errorf("%s answered %d", relay, resp.StatusCode)
}

// zbase32 is how Pkarr writes a public key in a relay's URL.
func zbase32(b []byte) string {
	const alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769"
	var out []byte
	var buf uint64
	bits := 0
	for _, c := range b {
		buf = buf<<8 | uint64(c)
		bits += 8
		for bits >= 5 {
			out = append(out, alphabet[(buf>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		out = append(out, alphabet[(buf<<(5-bits))&31])
	}
	return string(out)
}

// txtPacket is a DNS answer packet with one TXT record at name: first, then data split
// into 255 byte strings.
func txtPacket(name, first, data string) []byte {
	var rdata []byte
	rdata = append(rdata, byte(len(first)))
	rdata = append(rdata, first...)
	for len(data) > 0 {
		n := min(len(data), 255)
		rdata = append(rdata, byte(n))
		rdata = append(rdata, data[:n]...)
		data = data[n:]
	}
	p := []byte{0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0} // id 0, response + authoritative, 1 answer
	p = append(p, byte(len(name)))
	p = append(p, name...)
	p = append(p, 0)
	p = append(p, 0, 16, 0, 1) // TXT, IN
	p = binary.BigEndian.AppendUint32(p, 300)
	p = binary.BigEndian.AppendUint16(p, uint16(len(rdata)))
	return append(p, rdata...)
}

// txtStrings finds the TXT record at name in a DNS packet and returns its strings.
func txtStrings(p []byte, name string) ([]string, error) {
	bad := errors.New("damaged address record")
	if len(p) < 12 {
		return nil, bad
	}
	qd, an := int(binary.BigEndian.Uint16(p[4:])), int(binary.BigEndian.Uint16(p[6:]))
	off := 12
	for i := 0; i < qd; i++ {
		_, next, err := readName(p, off)
		if err != nil || next+4 > len(p) {
			return nil, bad
		}
		off = next + 4
	}
	for i := 0; i < an; i++ {
		n, next, err := readName(p, off)
		if err != nil || next+10 > len(p) {
			return nil, bad
		}
		typ := binary.BigEndian.Uint16(p[next:])
		rdlen := int(binary.BigEndian.Uint16(p[next+8:]))
		start := next + 10
		if start+rdlen > len(p) {
			return nil, bad
		}
		if typ == 16 && strings.EqualFold(n, name) {
			var out []string
			rd := p[start : start+rdlen]
			for len(rd) > 0 {
				l := int(rd[0])
				if 1+l > len(rd) {
					return nil, bad
				}
				out = append(out, string(rd[1:1+l]))
				rd = rd[1+l:]
			}
			return out, nil
		}
		off = start + rdlen
	}
	return nil, errors.New("no PAN Link address in the record")
}

// readName reads a DNS name at off (following compression pointers) and returns it
// without the trailing dot, and where the record goes on.
func readName(p []byte, off int) (string, int, error) {
	var labels []string
	next := -1
	for hops := 0; hops < 16; {
		if off >= len(p) {
			return "", 0, errors.New("name runs off the packet")
		}
		l := int(p[off])
		switch {
		case l == 0:
			if next < 0 {
				next = off + 1
			}
			return strings.Join(labels, "."), next, nil
		case l&0xC0 == 0xC0:
			if off+1 >= len(p) {
				return "", 0, errors.New("name runs off the packet")
			}
			if next < 0 {
				next = off + 2
			}
			off = int(binary.BigEndian.Uint16(p[off:]) & 0x3FFF)
			hops++
		default:
			if off+1+l > len(p) {
				return "", 0, errors.New("name runs off the packet")
			}
			labels = append(labels, string(p[off+1:off+1+l]))
			off += 1 + l
		}
	}
	return "", 0, errors.New("name loops")
}
