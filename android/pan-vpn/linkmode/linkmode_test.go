package linkmode

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	link "dev.pan/link"
	"github.com/tailscale/wireguard-go/conn"
)

var loopback = netip.MustParseAddr("127.0.0.1")

// Real UDP, but on 127.0.0.1 only, so no firewall prompt.
func binds() conn.Bind { return link.NewAddrBind(loopback) }

// fakePAN answers with the identity headers the hub added.
func fakePAN(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, r.Header.Get(link.HeaderDevice)+"|"+r.Header.Get(link.HeaderDeviceName)+"|"+r.URL.Path)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// startHub runs a hub from statePath on 127.0.0.1:port (0 picks one) in front of pan.
func startHub(t *testing.T, pan, statePath string, port int) (*link.Hub, *link.Link, int) {
	t.Helper()
	st, err := link.LoadOrCreateHubState(statePath, port)
	if err != nil {
		t.Fatal(err)
	}
	l, err := link.Start(link.Config{PrivateKey: st.PrivateKey, TunnelIP: st.HubIP, ListenPort: port, Bind: binds()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	h, err := link.NewHub(l, pan, st, statePath)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := l.ListenPort()
	h.Endpoints = func() []string { return []string{netip.AddrPortFrom(loopback, uint16(p)).String()} }
	go h.Serve()
	return h, l, p
}

func code(t *testing.T, h *link.Hub) string {
	t.Helper()
	info, err := h.StartPairing("", 0)
	if err != nil {
		t.Fatal(err)
	}
	uri, err := info.URI()
	if err != nil {
		t.Fatal(err)
	}
	return uri
}

// get asks PAN through the phone's local port, the way the app's HTTP client does.
func get(port int, path string, timeout time.Duration) (string, error) {
	resp, err := (&http.Client{Timeout: timeout}).Get("http://127.0.0.1:" + strconv.Itoa(port) + path)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

// The app's whole flow: pair with a code, start, talk to PAN through the local port as
// this phone, check the status, forget the pairing.
func TestPairStartAndUse(t *testing.T) {
	pan := fakePAN(t)
	h, _, _ := startHub(t, pan, filepath.Join(t.TempDir(), "link.json"), 0)
	dataDir := t.TempDir()
	if Paired(dataDir) {
		t.Fatal("paired before pairing")
	}
	id, err := Pair(context.Background(), dataDir, code(t, h), "Pixel test", binds)
	if err != nil {
		t.Fatal(err)
	}
	if !Paired(dataDir) {
		t.Fatal("pairing not saved")
	}
	c, err := Start(context.Background(), dataDir, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	body, err := get(c.Port(), "/api/v1/auth/me", 6*time.Second)
	if err != nil || body != id+"|Pixel test|/api/v1/auth/me" {
		t.Fatalf("through the local port: %q %v", body, err)
	}
	s := c.Status()
	if !s.Connected || s.DeviceID != id || s.Via == "" || s.SinceHandshake < 0 {
		t.Fatalf("status %+v", s)
	}
	if err := c.NetworkChanged(); err != nil {
		t.Fatal(err)
	}
	c.Close()
	if err := Forget(dataDir); err != nil || Paired(dataDir) {
		t.Fatalf("forget: %v, still paired %v", err, Paired(dataDir))
	}
	if err := Forget(dataDir); err != nil {
		t.Fatalf("forgetting twice: %v", err)
	}
}

// A phone often starts with no network. Start must not wait for the hub, and the app's
// requests must work once the hub is reachable, without starting again.
func TestStartBeforeTheHubIsUp(t *testing.T) {
	pan := fakePAN(t)
	statePath := filepath.Join(t.TempDir(), "link.json")
	h, l, port := startHub(t, pan, statePath, 0)
	dataDir := t.TempDir()
	id, err := Pair(context.Background(), dataDir, code(t, h), "Pixel test", binds)
	if err != nil {
		t.Fatal(err)
	}
	l.Close() // the hub goes away

	start := time.Now()
	c, err := Start(context.Background(), dataDir, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if took := time.Since(start); took > time.Second {
		t.Fatalf("Start waited %v for a hub that is down", took)
	}
	if _, err := get(c.Port(), "/x", 1500*time.Millisecond); err == nil {
		t.Fatal("got an answer with the hub down")
	}

	startHub(t, pan, statePath, port) // the hub is back, same address
	back := time.Now()
	for {
		if body, err := get(c.Port(), "/again", 1500*time.Millisecond); err == nil && strings.HasPrefix(body, id+"|") {
			break
		}
		if time.Since(back) > 15*time.Second {
			t.Fatal("no answer 15 s after the hub came back")
		}
	}
	t.Logf("answers %v after the hub came back", time.Since(back).Round(time.Millisecond))
}
