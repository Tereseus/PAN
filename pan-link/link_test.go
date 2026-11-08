package link

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
	"github.com/tailscale/wireguard-go/conn/bindtest"
)

var loopback = netip.MustParseAddr("127.0.0.1")

// PAN stand in: answers with the identity headers it was given.
func fakePAN(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(w, r.Header.Get(HeaderDevice)+"|"+r.Header.Get(HeaderDeviceName)+"|"+r.Header.Get(HeaderSecret)+"|"+r.URL.Path)
	}))
	t.Cleanup(srv.Close)
	return srv
}

type testHub struct {
	hub   *Hub
	link  *Link
	state *HubState
	path  string
}

// newTestHub starts a hub on the given bind. statePath "" keeps state in memory.
func newTestHub(t *testing.T, pan string, bind conn.Bind, statePath string, endpoints []string) *testHub {
	t.Helper()
	var st *HubState
	var err error
	if statePath != "" {
		st, err = LoadOrCreateHubState(statePath, 0)
	} else {
		priv, _, _ := GenerateKey()
		st = &HubState{PrivateKey: priv, HubIP: DefaultHubIP, Secret: "s3cret"}
	}
	if err != nil {
		t.Fatal(err)
	}
	l, err := Start(Config{PrivateKey: st.PrivateKey, TunnelIP: st.HubIP, Bind: bind})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	h, err := NewHub(l, pan, st, statePath)
	if err != nil {
		t.Fatal(err)
	}
	if endpoints == nil {
		port, err := l.ListenPort()
		if err != nil {
			t.Fatal(err)
		}
		endpoints = []string{netip.AddrPortFrom(loopback, uint16(port)).String()}
	}
	h.Endpoints = func() []string { return endpoints }
	go h.Serve()
	return &testHub{hub: h, link: l, state: st, path: statePath}
}

func get(t *testing.T, l *Link, path string, hdr map[string]string) (string, error) {
	t.Helper()
	req, _ := http.NewRequest("GET", hubURL(DefaultHubIP, path), nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := tunnelClient(l, 6*time.Second).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return string(b), &statusErr{resp.StatusCode}
	}
	return string(b), nil
}

type statusErr struct{ code int }

func (e *statusErr) Error() string { return http.StatusText(e.code) }

func TestKeyPair(t *testing.T) {
	priv, pub, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	got, err := PublicKey(priv)
	if err != nil || got != pub {
		t.Fatalf("PublicKey(priv) = %q, %v; want %q", got, err, pub)
	}
	if _, err := PublicKey("not a key"); err == nil {
		t.Fatal("bad key accepted")
	}
}

func TestPairURIRoundTrip(t *testing.T) {
	_, hubPub, _ := GenerateKey()
	once, _, _ := GenerateKey()
	in := PairInfo{HubKey: hubPub, HubIP: DefaultHubIP, OneTime: once, DeviceIP: netip.MustParseAddr("10.77.0.9"),
		Endpoints: []string{"192.168.50.20:41700", "[2001:db8::5]:41700"}, Expires: time.Unix(1800000000, 0), HubName: "Home"}
	uri, err := in.URI()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(uri, "pan://pair?") || len(uri) > 400 {
		t.Fatalf("odd uri (%d chars): %s", len(uri), uri)
	}
	out, err := ParsePairURI(uri)
	if err != nil {
		t.Fatal(err)
	}
	if out.HubKey != in.HubKey || out.OneTime != in.OneTime || out.DeviceIP != in.DeviceIP ||
		strings.Join(out.Endpoints, ",") != strings.Join(in.Endpoints, ",") || !out.Expires.Equal(in.Expires) || out.HubName != "Home" {
		t.Fatalf("round trip changed it:\n in %+v\nout %+v", in, out)
	}
	for _, bad := range []string{"https://pair?v=1", "pan://pair?v=2", strings.Replace(uri, "e=", "e=nonsense", 1)} {
		if _, err := ParsePairURI(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// The whole flow in memory: QR, pairing, PAN sees the real device, forged headers dropped,
// the QR is useless afterwards.
func TestPairingFlowInMemory(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	phoneBind := func() conn.Bind { return binds[1] }

	info, err := th.hub.StartPairing("My Pixel", 0)
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBind)
	if err != nil {
		t.Fatalf("pairing failed: %v", err)
	}
	if st.DeviceID == "" || strings.HasPrefix(st.DeviceID, "dev-") || st.Name != "My Pixel" {
		t.Fatalf("bad device record: %+v", st)
	}

	phone, ep, err := Connect(context.Background(), st, phoneBind)
	if err != nil {
		t.Fatalf("connect with permanent key failed: %v", err)
	}
	// Connect reports the address WireGuard learned from the hub's answers. The in-memory
	// bind labels every packet it receives with its second lane ("127.0.0.1:4"), so either
	// of the phone bind's two names is right here. TestConnectTriesAllAddressesAtOnce checks
	// the exact address over real UDP.
	if ep != "127.0.0.1:2" && ep != "127.0.0.1:4" {
		t.Fatalf("used endpoint %q", ep)
	}
	body, err := get(t, phone, "/health", map[string]string{HeaderDevice: "owner-laptop", HeaderSecret: "guess"})
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if want := st.DeviceID + "|My Pixel|s3cret|/health"; body != want {
		t.Fatalf("PAN saw %q, want %q", body, want)
	}
	phone.Close()

	// The same QR again (a photo of it) must not pair a second device.
	before := hits.Load()
	if _, err := Pair(context.Background(), uri, "thief", phoneBind); err == nil {
		t.Fatal("a used pairing code worked twice")
	}
	if hits.Load() != before {
		t.Fatal("PAN was reached during the refused pairing")
	}
	if n := len(th.hub.Devices()); n != 1 {
		t.Fatalf("%d devices, want 1", n)
	}
}

func TestStrangerKeyGetsNothing(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	hubPub, _ := PublicKey(th.state.PrivateKey)

	// A stranger knows the hub's public key and address and picks a tunnel address,
	// but its key was never paired.
	strangerPriv, _, _ := GenerateKey()
	stranger, err := Start(Config{PrivateKey: strangerPriv, TunnelIP: netip.MustParseAddr("10.77.0.2"), Bind: binds[1],
		Peers: []Peer{{PublicKey: hubPub, TunnelIP: DefaultHubIP, Endpoint: "127.0.0.1:2"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer stranger.Close()
	if _, err := get(t, stranger, "/health", nil); err == nil {
		t.Fatal("stranger got an answer")
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("PAN was reached %d times by a stranger", n)
	}
}

func TestPendingDeviceCannotReachPAN(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	info, _ := th.hub.StartPairing("half paired", 0)

	// Holding the one time key gets you the pairing endpoint only, never PAN.
	l, err := Start(Config{PrivateKey: info.OneTime, TunnelIP: info.DeviceIP, Bind: binds[1],
		Peers: []Peer{{PublicKey: info.HubKey, TunnelIP: info.HubIP, Endpoint: "127.0.0.1:2"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, err := get(t, l, "/.pan-link/ping", nil); err != nil {
		t.Fatalf("ping refused: %v", err)
	}
	if _, err := get(t, l, "/api/v1/stats", nil); err == nil {
		t.Fatal("a device that has not finished pairing reached PAN")
	}
	if hits.Load() != 0 {
		t.Fatal("PAN was reached")
	}
}

func TestExpiredCodeRefused(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	info, _ := th.hub.StartPairing("late", time.Minute)
	uri, _ := info.URI()

	// The hub's clock moves past the expiry before the phone finishes.
	th.hub.mu.Lock()
	th.hub.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	th.hub.mu.Unlock()
	start := time.Now()
	_, err := Pair(context.Background(), uri, "", func() conn.Bind { return binds[1] })
	if err == nil {
		t.Fatal("expired code paired")
	}
	if !strings.Contains(err.Error(), "expired") || time.Since(start) > 4*time.Second {
		t.Fatalf("want a quick 'expired' answer, got %v after %v", err, time.Since(start))
	}
	th.hub.ExpirePending()
	if len(th.hub.pending) != 0 || len(th.hub.Devices()) != 0 {
		t.Fatal("expired pairing left something behind")
	}
}

func TestAdminNeedsSecret(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	admin := th.hub.AdminHandler()

	for _, secret := range []string{"", "wrong", "s3cre"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/admin/pair", strings.NewReader(`{"name":"x"}`))
		if secret != "" {
			req.Header.Set(HeaderSecret, secret)
		}
		admin.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("secret %q: got %d", secret, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/admin/pair", strings.NewReader(`{"name":"Pixel"}`))
	req.Header.Set(HeaderSecret, "s3cret")
	admin.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `pan://pair?`) {
		t.Fatalf("with secret: %d %s", rec.Code, rec.Body.String())
	}
}

// Real UDP sockets, but only on 127.0.0.1, so no firewall prompt. Then a restart: the
// hub reloads its state file and the phone's permanent key still works. Then unpairing.
func TestRealUDPOnLoopbackAndRestart(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }

	th := newTestHub(t, pan.URL, NewAddrBind(loopback), statePath, nil)
	info, _ := th.hub.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatalf("pairing over real UDP failed: %v", err)
	}

	// The phone's apps use a local port; the proxy carries it to PAN on the hub.
	phone, _, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go phone.ServeLocalProxy(ln, st.HubIP)
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Get("http://" + ln.Addr().String() + "/api/v1/stats")
	if err != nil {
		t.Fatalf("local proxy request failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(string(body), st.DeviceID+"|Pixel|") {
		t.Fatalf("PAN saw %q", body)
	}
	ln.Close()
	phone.Close()
	th.link.Close()

	// Restart the hub from its state file, on a new port.
	th2 := newTestHub(t, pan.URL, NewAddrBind(loopback), statePath, nil)
	if n := len(th2.hub.Devices()); n != 1 {
		t.Fatalf("after restart %d devices, want 1", n)
	}
	st.Endpoints = th2.hub.Endpoints()
	phone2, _, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatalf("permanent key refused after restart: %v", err)
	}
	if body, err := get(t, phone2, "/again", nil); err != nil || !strings.HasPrefix(body, st.DeviceID) {
		t.Fatalf("after restart: %q %v", body, err)
	}
	phone2.Close()

	// Unpair: the key stops working at once and the state file forgets it.
	if err := th2.hub.RemoveDevice(st.DeviceID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Connect(context.Background(), st, phoneBinds); err == nil {
		t.Fatal("unpaired device still connects")
	}
	saved, err := LoadOrCreateHubState(statePath, 0)
	if err != nil || len(saved.Devices) != 0 {
		t.Fatalf("state after unpair: %+v %v", saved, err)
	}
}

// hubOnPort starts a hub from statePath on 127.0.0.1:port (0 picks a port).
func hubOnPort(t *testing.T, pan, statePath string, port int) (*Hub, *Link, int) {
	t.Helper()
	st, err := LoadOrCreateHubState(statePath, port)
	if err != nil {
		t.Fatal(err)
	}
	l, err := Start(Config{PrivateKey: st.PrivateKey, TunnelIP: st.HubIP, ListenPort: port, Bind: NewAddrBind(loopback)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	h, err := NewHub(l, pan, st, statePath)
	if err != nil {
		t.Fatal(err)
	}
	p, err := l.ListenPort()
	if err != nil {
		t.Fatal(err)
	}
	h.Endpoints = func() []string { return []string{netip.AddrPortFrom(loopback, uint16(p)).String()} }
	go h.Serve()
	return h, l, p
}

// After a restart the hub reaches out to each device at the address it last used, so a
// device that stayed connected is back at once instead of after WireGuard's own wait
// (about 15 s, 12 s in the dev PAN run). Real UDP on 127.0.0.1, same port both times.
func TestHubReachesOutAfterRestart(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	phoneBinds := func() conn.Bind { return NewAddrBind(loopback) }

	h1, l1, port := hubOnPort(t, pan.URL, statePath, 0)
	info, _ := h1.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	phone, _, err := Connect(context.Background(), st, phoneBinds)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(phone.Close)
	if _, err := get(t, phone, "/before", nil); err != nil {
		t.Fatal(err)
	}
	if err := h1.RememberEndpoints(); err != nil {
		t.Fatal(err)
	}
	if saved := loadEndpoints(endpointsFile(statePath)); saved[st.DeviceID] == "" {
		t.Fatalf("device address not saved: %v", saved)
	}
	l1.Close()

	// Same phone link as before: nothing on the phone side reconnects or retries early.
	start := time.Now()
	hubOnPort(t, pan.URL, statePath, port)
	for {
		req, _ := http.NewRequest("GET", hubURL(DefaultHubIP, "/after"), nil)
		resp, err := tunnelClient(phone, 1500*time.Millisecond).Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 && strings.HasPrefix(string(body), st.DeviceID) {
				break
			}
		}
		if time.Since(start) > 25*time.Second {
			t.Fatal("device not back 25 s after the hub restarted")
		}
	}
	took := time.Since(start)
	t.Logf("device back %v after the hub restarted", took.Round(time.Millisecond))
	if took > 5*time.Second {
		t.Fatalf("device back only after %v; the hub should have reached out at once", took.Round(time.Millisecond))
	}
}

// A damaged endpoints file must never keep the hub from starting.
func TestBadSavedEndpointIsIgnored(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	statePath := filepath.Join(t.TempDir(), "link.json")
	h1, l1, _ := hubOnPort(t, pan.URL, statePath, 0)
	info, _ := h1.StartPairing("Pixel", 0)
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", func() conn.Bind { return NewAddrBind(loopback) })
	if err != nil {
		t.Fatal(err)
	}
	l1.Close()
	if err := saveEndpoints(endpointsFile(statePath), map[string]string{st.DeviceID: "not an address"}); err != nil {
		t.Fatal(err)
	}
	h2, _, _ := hubOnPort(t, pan.URL, statePath, 0)
	if n := len(h2.Devices()); n != 1 {
		t.Fatalf("after restart %d devices, want 1", n)
	}
}

// The port mapper must not talk to the router until asked: making one and closing it
// sends nothing (no Probe, no External), so this is safe on any network.
func TestPortMapperIdleOpensNothing(t *testing.T) {
	pm, err := NewPortMapper(41720, t.Logf, nil)
	if err != nil {
		t.Fatal(err)
	}
	pm.Close()
}
