package linkmode

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	link "dev.pan/link"
)

// relayStub stands in for a Pkarr relay: newest record per key, older ones refused.
func relayStub(t *testing.T) string {
	t.Helper()
	var mu sync.Mutex
	recs := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		key := strings.TrimPrefix(r.URL.Path, "/")
		switch r.Method {
		case "PUT":
			body, _ := io.ReadAll(r.Body)
			if old, ok := recs[key]; ok && binary.BigEndian.Uint64(old[64:]) >= binary.BigEndian.Uint64(body[64:]) {
				http.Error(w, "older", http.StatusConflict)
				return
			}
			recs[key] = body
			w.WriteHeader(http.StatusNoContent)
		case "GET":
			if b, ok := recs[key]; ok {
				w.Write(b)
				return
			}
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// The hub moved (restarted on another port, as after a new public address) while the
// phone was away. The phone's link finds it through the address record by itself, and
// the pairing keeps the new address.
func TestPhoneFindsAHubThatMoved(t *testing.T) {
	saved := []any{watchTick, lookupAfter, lookupRetry, Relays}
	watchTick, lookupAfter, lookupRetry = 100*time.Millisecond, 300*time.Millisecond, time.Second
	relay := relayStub(t)
	Relays = []string{relay}
	defer func() {
		watchTick, lookupAfter, lookupRetry = saved[0].(time.Duration), saved[1].(time.Duration), saved[2].(time.Duration)
		Relays = saved[3].([]string)
	}()

	pan := fakePAN(t)
	statePath := filepath.Join(t.TempDir(), "link.json")
	h1, l1, _ := startHub(t, pan, statePath, 0)
	dataDir := t.TempDir()
	id, err := Pair(context.Background(), dataDir, code(t, h1), "Pixel test", binds)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := link.LoadClientState(File(dataDir))
	if st.RecordKey == "" {
		t.Fatal("pairing saved no address record key")
	}
	l1.Close()

	h2, _, port2 := startHub(t, pan, statePath, 0)
	h2.Relays = []string{relay}
	if ok, err := h2.PublishAddresses(context.Background()); !ok || err != nil {
		t.Fatalf("publish: %v %v", ok, err)
	}

	t0 := time.Now()
	c, err := Start(context.Background(), dataDir, binds)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var body string
	for time.Since(t0) < 10*time.Second {
		if body, err = get(c.Port(), "/found", time.Second); err == nil {
			break
		}
	}
	if err != nil || !strings.HasPrefix(body, id+"|") {
		t.Fatalf("hub not found through its record: %q %v (status %+v)", body, err, c.Status())
	}
	t.Logf("found and reached %v after start (lookup after %v)", time.Since(t0).Round(time.Millisecond), lookupAfter)
	if s := c.Status(); s.Lookup != "1 addresses, 1 new" {
		t.Fatalf("status says %q", s.Lookup)
	}
	st, _ = link.LoadClientState(File(dataDir))
	want := netip.AddrPortFrom(loopback, uint16(port2)).String()
	if len(st.Endpoints) != 1 || st.Endpoints[0] != want || st.RecordSeq == 0 {
		t.Fatalf("saved pairing: %v seq %d, want [%s]", st.Endpoints, st.RecordSeq, want)
	}
}
