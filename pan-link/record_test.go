package link

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// fakeRelay stands in for a Pkarr relay: it keeps the newest signed record per key and
// refuses an older one, as the real relays do.
type fakeRelay struct {
	*httptest.Server
	mu   sync.Mutex
	recs map[string][]byte
	puts atomic.Int32
	down atomic.Bool
}

func newFakeRelay(t *testing.T) *fakeRelay {
	t.Helper()
	f := &fakeRelay{recs: map[string][]byte{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.down.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/")
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case "PUT":
			f.puts.Add(1)
			body, _ := io.ReadAll(r.Body)
			if old, ok := f.recs[key]; ok && binary.BigEndian.Uint64(old[64:]) >= binary.BigEndian.Uint64(body[64:]) {
				http.Error(w, "older", http.StatusConflict)
				return
			}
			f.recs[key] = body
			w.WriteHeader(http.StatusNoContent)
		case "GET":
			b, ok := f.recs[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(b)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func testKeys(t *testing.T) (ed25519.PrivateKey, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return priv, randomBytes(32)
}

func TestRecordRoundTrip(t *testing.T) {
	priv, secret := testKeys(t)
	pub := priv.Public().(ed25519.PublicKey)
	addrs := []string{"192.168.50.20:41720", "[2001:db8::7]:41720", "203.0.113.9:41720", "100.101.102.103:41720", "home.example.net:41720"}
	pkt, n, err := sealAddresses(secret, addrs)
	if err != nil || n != len(addrs) {
		t.Fatalf("seal: %d %v", n, err)
	}
	if strings.Contains(string(pkt), "192.168") || strings.Contains(string(pkt), "example") {
		t.Fatal("addresses readable in the record")
	}
	body := signRecord(priv, 42, pkt)
	seq, v, err := verifyRecord(pub, body)
	if err != nil || seq != 42 {
		t.Fatalf("verify: %d %v", seq, err)
	}
	got, err := openAddresses(secret, v)
	if err != nil || strings.Join(got, ",") != strings.Join(addrs, ",") {
		t.Fatalf("open: %v %v", got, err)
	}

	// One flipped bit anywhere: refused.
	for _, i := range []int{3, 70, len(body) - 5} {
		bad := append([]byte(nil), body...)
		bad[i] ^= 1
		if _, _, err := verifyRecord(pub, bad); err == nil {
			t.Fatalf("flipped byte %d accepted", i)
		}
	}
	// Someone else's key: refused. Someone else's secret: unreadable.
	other, otherSecret := testKeys(t)
	if _, _, err := verifyRecord(other.Public().(ed25519.PublicKey), body); err == nil {
		t.Fatal("record checked out against another key")
	}
	if _, err := openAddresses(otherSecret, v); err == nil {
		t.Fatal("record opened with another secret")
	}
	// A record signed by another key under this one's name: refused.
	if _, _, err := verifyRecord(pub, signRecord(other, 43, pkt)); err == nil {
		t.Fatal("record signed by another key accepted")
	}
}

func TestRecordCutsAddressesThatDontFit(t *testing.T) {
	_, secret := testKeys(t)
	var addrs []string
	for i := range 40 {
		addrs = append(addrs, fmt.Sprintf("[2001:db8:aaaa:bbbb:cccc:dddd:eeee:%x]:41720", i))
	}
	pkt, n, err := sealAddresses(secret, addrs)
	if err != nil || n == 0 || n >= len(addrs) || len(pkt) > maxSignedValue {
		t.Fatalf("n=%d len=%d err=%v", n, len(pkt), err)
	}
	got, err := openAddresses(secret, pkt)
	if err != nil || len(got) != n || got[0] != addrs[0] {
		t.Fatalf("open: %d %v", len(got), err)
	}
}

func TestZBase32(t *testing.T) {
	// Examples from the z-base-32 description.
	for in, want := range map[string]string{"\xf0\xbf\xc7": "6n9hq", "\xd4\x7a\x04": "4t7ye"} {
		if got := zbase32([]byte(in)); got != want {
			t.Errorf("zbase32(%x) = %s, want %s", in, got, want)
		}
	}
	if n := len(zbase32(make([]byte, 32))); n != 52 {
		t.Errorf("a key is %d characters, want 52", n)
	}
}

// A hub that moved (restarted on another port, as after a new public address) is found
// through its record: the device's saved address is dead, the record has the new one.
func TestDeviceFindsAHubThatMoved(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	relay := newFakeRelay(t)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }

	h1, l1, _ := hubOnPort(t, pan.URL, statePath, 0)
	h1.Relays = []string{relay.URL}
	if ok, err := h1.PublishAddresses(context.Background()); ok || err != nil || relay.puts.Load() != 0 {
		t.Fatalf("published with no paired device: %v %v", ok, err)
	}
	info, _ := h1.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	if st.RecordKey == "" || st.RecordSecret == "" || st.RecordKey != h1.RecordInfo().Key {
		t.Fatalf("pairing gave no record keys: %+v", st)
	}
	ok, err := h1.PublishAddresses(context.Background())
	if !ok || err != nil {
		t.Fatalf("publish: %v %v", ok, err)
	}
	if ok, _ := h1.PublishAddresses(context.Background()); ok {
		t.Fatal("published again with nothing changed")
	}
	l1.Close()

	// The hub comes back on a new port. Its record says so.
	h2, _, port2 := hubOnPort(t, pan.URL, statePath, 0)
	h2.Relays = []string{relay.URL}
	if ok, err := h2.PublishAddresses(context.Background()); !ok || err != nil {
		t.Fatalf("publish after the move: %v %v", ok, err)
	}

	// The device only knows the old address: nothing gets through.
	phone, err := Open(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	if _, err := getWithin(phone, "/before", 1500*time.Millisecond); err == nil {
		t.Fatal("reached the hub on its old address")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	addrs, seq, err := FindHub(ctx, st, []string{relay.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := netip.AddrPortFrom(loopback, uint16(port2)).String()
	if len(addrs) != 1 || addrs[0] != want || seq == 0 {
		t.Fatalf("record says %v (seq %d), want %s", addrs, seq, want)
	}
	if n := phone.AddHubAddresses(ctx, st.HubKey, addrs); n != 1 {
		t.Fatalf("%d new addresses, want 1", n)
	}
	t0 := time.Now()
	body, err := getWithin(phone, "/after", 6*time.Second)
	if err != nil || !strings.HasPrefix(body, st.DeviceID) {
		t.Fatalf("after the lookup: %q %v", body, err)
	}
	t.Logf("through the new address %v after adding it", time.Since(t0).Round(time.Millisecond))

	// An older record than the one used is refused.
	st.RecordSeq = seq + 1
	if _, _, err := FindHub(ctx, st, []string{relay.URL}, nil); err == nil {
		t.Fatal("older record accepted")
	}
}

// A removed device can't read where the hub is afterwards; the others get the new key
// through the tunnel and can.
func TestRemovedDeviceLosesTheRecord(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	relay := newFakeRelay(t)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }
	h, _, _ := hubOnPort(t, pan.URL, statePath, 0)
	h.Relays = []string{relay.URL}

	pair := func(name string) *ClientState {
		info, _ := h.StartPairing(name, 0)
		uri, _ := info.URI()
		st, err := Pair(context.Background(), uri, name, phoneBinds)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	lost, kept := pair("lost phone"), pair("laptop")
	if _, err := h.PublishAddresses(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, _, err := FindHub(ctx, lost, []string{relay.URL}, nil); err != nil {
		t.Fatalf("before removal: %v", err)
	}
	if err := h.RemoveDevice(lost.DeviceID); err != nil {
		t.Fatal(err)
	}
	if ok, err := h.PublishAddresses(context.Background()); !ok || err != nil {
		t.Fatalf("no new record after removal: %v %v", ok, err)
	}
	if _, _, err := FindHub(ctx, lost, []string{relay.URL}, nil); err == nil {
		t.Fatal("removed device still reads the record")
	}
	// The kept device has the old key too, until it asks the hub.
	if _, _, err := FindHub(ctx, kept, []string{relay.URL}, nil); err == nil {
		t.Fatal("old key opened the new record")
	}
	l, _, err := Connect(context.Background(), kept, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	changed, err := FetchRecordInfo(context.Background(), l, kept)
	if err != nil || !changed {
		t.Fatalf("fetch: %v %v", changed, err)
	}
	if _, _, err := FindHub(ctx, kept, []string{relay.URL}, nil); err != nil {
		t.Fatalf("kept device after fetching the new key: %v", err)
	}
	// The removed device can't fetch it: the hub no longer knows its key.
	short, cancelShort := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelShort()
	if _, _, err := Connect(short, lost, phoneBinds); err == nil {
		t.Fatal("removed device connected")
	}
}

// A hub set up before records gets their keys on its next start, saved in link.json.
func TestOldHubStateGetsRecordKeys(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	priv, _, _ := GenerateKey()
	old := map[string]any{"private_key": priv, "hub_ip": "10.77.0.1", "listen_port": 0, "secret": "s3cret", "devices": []any{}}
	b, _ := json.Marshal(old)
	if err := os.WriteFile(statePath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	h, _, _ := hubOnPort(t, pan.URL, statePath, 0)
	info := h.RecordInfo()
	if k, err := base64.StdEncoding.DecodeString(info.Key); err != nil || len(k) != 32 {
		t.Fatalf("no record key: %+v", info)
	}
	saved, err := LoadOrCreateHubState(statePath, 0)
	if err != nil || saved.RecordSeed == "" || saved.RecordSecret != info.Secret || saved.Secret != "s3cret" {
		t.Fatalf("state after start: %+v %v", saved, err)
	}
}

// No relay answering is an error that says so, not a hang.
func TestNoRelayAnswers(t *testing.T) {
	relay := newFakeRelay(t)
	relay.down.Store(true)
	priv, secret := testKeys(t)
	st := &ClientState{RecordKey: base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)), RecordSecret: base64.StdEncoding.EncodeToString(secret)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := FindHub(ctx, st, []string{relay.URL, "http://127.0.0.1:9"}, nil); err == nil {
		t.Fatal("no error with every relay down")
	}
	relay.down.Store(false)
	if _, _, err := FindHub(ctx, st, []string{relay.URL}, nil); err != ErrNoRecord {
		t.Fatalf("empty relay: %v, want ErrNoRecord", err)
	}
}

// getWithin asks PAN through the link with a time limit.
func getWithin(l *Link, path string, limit time.Duration) (string, error) {
	resp, err := tunnelClient(l, limit).Get(hubURL(DefaultHubIP, path))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

// Against Pkarr's real relays, with a throwaway key and documentation addresses only
// (192.0.2.0/24, 198.51.100.0/24, 2001:db8::/32). Only with PAN_LINK_LIVE=1: it uses the
// internet.
func TestLiveRelays(t *testing.T) {
	if os.Getenv("PAN_LINK_LIVE") == "" {
		t.Skip("set PAN_LINK_LIVE=1 to use Pkarr's real relays")
	}
	priv, secret := testKeys(t)
	pub := priv.Public().(ed25519.PublicKey)
	addrs := []string{"192.0.2.10:41720", "[2001:db8::10]:41720", "198.51.100.7:41720", "[2001:db8:1234:5678::20]:41720"}
	pkt, _, err := sealAddresses(secret, addrs)
	if err != nil {
		t.Fatal(err)
	}
	body := signRecord(priv, uint64(time.Now().UnixMicro()), pkt)
	z := zbase32(pub)
	hc := &http.Client{Timeout: 30 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	took := 0
	for _, r := range DefaultRelays {
		t0 := time.Now()
		err := relayPut(ctx, hc, r, z, body)
		t.Logf("PUT %-26s %v in %v", r, err, time.Since(t0).Round(time.Millisecond))
		if err == nil {
			took++
		}
	}
	if took == 0 {
		t.Fatal("no relay took the record")
	}
	st := &ClientState{RecordKey: base64.StdEncoding.EncodeToString(pub), RecordSecret: base64.StdEncoding.EncodeToString(secret)}
	for _, r := range DefaultRelays {
		t0 := time.Now()
		got, seq, err := FindHub(ctx, st, []string{r}, hc)
		t.Logf("GET %-26s %d addresses, seq %d, %v in %v", r, len(got), seq, err, time.Since(t0).Round(time.Millisecond))
	}
	t0 := time.Now()
	got, _, err := FindHub(ctx, st, nil, hc)
	if err != nil || strings.Join(got, ",") != strings.Join(addrs, ",") {
		t.Fatalf("all relays: %v %v", got, err)
	}
	t.Logf("FindHub on all relays: %v", time.Since(t0).Round(time.Millisecond))
}
