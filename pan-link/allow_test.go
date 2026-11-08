package link

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tailscale/wireguard-go/conn"
	"github.com/tailscale/wireguard-go/conn/bindtest"
)

// What a work computer may send in PAN's own preset (service/src/routes/link.js).
var workAllow = []string{
	"POST /api/v1/notify/inbound",
	"POST /api/v1/slack/inbound",
	"GET /ws/client",
	"GET /health",
}

func TestCheckAllow(t *testing.T) {
	good := [][]string{nil, {}, workAllow, {"* /api/v1/notify/inbound"}, {"GET /static/*"}}
	for _, rules := range good {
		if err := CheckAllow(rules); err != nil {
			t.Errorf("%q refused: %v", rules, err)
		}
	}
	bad := []string{
		"/api/v1/notify/inbound",                  // no method
		"FETCH /api/v1/notify/inbound",            // not a method
		"post /api/v1/notify/inbound",             // lower case
		"GET api/v1/x",                            // no leading slash
		"GET /api/../v1/memory",                   // dot segments
		"GET /api//x",                             // double slash
		"GET /api/x/",                             // trailing slash
		"GET /api/*x",                             // a star that isn't a /* prefix
		"GET /*",                                  // everything: use no limit instead
		"GET /api/%2e%2e/x",                       // escapes
		"GET /api/x?y=1",                          // a query
		"GET /api x",                              // a space in the path
		"GET /" + strings.Repeat("a", maxRuleLen), // too long
	}
	for _, r := range bad {
		if err := CheckAllow([]string{r}); err == nil {
			t.Errorf("%q accepted", r)
		}
	}
	many := make([]string, maxAllowRules+1)
	for i := range many {
		many[i] = "GET /x"
	}
	if CheckAllow(many) == nil {
		t.Error("too many rules accepted")
	}
}

func TestAllowsMatching(t *testing.T) {
	rules := []string{"POST /api/v1/notify/inbound", "GET /static/*", "* /health"}
	cases := []struct {
		method, target string
		want           bool
	}{
		{"POST", "/api/v1/notify/inbound", true},
		{"POST", "/api/v1/notify/inbound?x=1", true},
		{"GET", "/api/v1/notify/inbound", false},    // wrong method
		{"POST", "/api/v1/notify/inbound/x", false}, // longer than an exact rule
		{"POST", "/api/v1/notify", false},
		{"GET", "/static/app.js", true},
		{"GET", "/static/", true},
		{"GET", "/static", false}, // the prefix is /static/
		{"GET", "/health", true},
		{"DELETE", "/health", true}, // * is any method
		{"POST", "/api/v1/notify/inbound/../../memory", false},
		{"POST", "/api/v1/notify/./inbound", false},
		{"POST", "//api/v1/notify/inbound", false},
		{"POST", "/api/v1/notify%2Finbound", false}, // an escaped slash
		{"POST", "/api/v1/notify/%69nbound", false}, // any escape
		{"GET", "/static/../api/v1/memory", false},
		{"GET", "/api/v1/memory", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "http://hub"+c.target, nil)
		if got := allows(rules, r); got != c.want {
			t.Errorf("%s %s: got %v, want %v", c.method, c.target, got, c.want)
		}
	}
	if !allows(nil, httptest.NewRequest("DELETE", "http://hub/api/v1/memory", nil)) {
		t.Error("no rules must mean no limit")
	}
}

// A limited device reaches PAN only with its own requests; everything else stops at
// pan-link, PAN never sees it, and the device keeps its identity on what does go through.
func TestLimitedDeviceOnlyReachesItsRequests(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	path := filepath.Join(t.TempDir(), "link.json")
	th := newTestHub(t, pan.URL, binds[0], path, []string{"127.0.0.1:2"})
	var refused []string
	th.hub.OnError = func(err error) { refused = append(refused, err.Error()) }
	pcBind := func() conn.Bind { return binds[1] }

	info, err := th.hub.StartPairingLimited("Work PC", 0, workAllow)
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", pcBind)
	if err != nil {
		t.Fatalf("pairing failed: %v", err)
	}
	pc, _, err := Connect(context.Background(), st, pcBind)
	if err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	defer pc.Close()
	client := tunnelClient(pc, 6*time.Second)
	send := func(method, path string) (int, string) {
		req, _ := http.NewRequest(method, hubURL(DefaultHubIP, path), strings.NewReader("{}"))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	code, body := send("POST", "/api/v1/notify/inbound")
	if code != 200 || body != st.DeviceID+"|Work PC|"+th.state.Secret+"|/api/v1/notify/inbound" {
		t.Fatalf("its own request: %d %q", code, body)
	}
	if code, _ := send("GET", "/health"); code != 200 {
		t.Fatalf("health: %d", code)
	}
	before := hits.Load()
	for _, r := range [][2]string{
		{"GET", "/api/v1/memory"},
		{"POST", "/mcp/pan"},
		{"POST", "/hooks/Stop"},
		{"GET", "/dashboard/api/events?q=x"},
		{"GET", "/api/v1/notify/inbound"},
		{"POST", "/api/v1/notify/inbound/../../v1/memory"},
		{"GET", "/ws/terminal"},
	} {
		code, body := send(r[0], r[1])
		if code != http.StatusForbidden || !strings.Contains(body, "limited") {
			t.Errorf("%s %s: %d %q", r[0], r[1], code, body)
		}
	}
	if hits.Load() != before {
		t.Fatalf("PAN was reached %d times by refused requests", hits.Load()-before)
	}
	if len(refused) == 0 || !strings.Contains(refused[0], "Work PC") {
		t.Fatalf("refusals not reported: %q", refused)
	}
	send("GET", "/api/v1/memory")
	if n := len(refused); n != 7 {
		t.Fatalf("%d refusal reports, want 7 (one per request kind)", n)
	}

	// The limit is saved with the pairing, and the admin API lifts it from the next request.
	saved, err := LoadOrCreateHubState(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Devices) != 1 || len(saved.Devices[0].Allow) != len(workAllow) {
		t.Fatalf("link.json devices: %+v", saved.Devices)
	}
	devs := th.hub.Devices()
	if len(devs) != 1 || len(devs[0].Allow) != len(workAllow) {
		t.Fatalf("devices: %+v", devs)
	}
	admin := th.hub.AdminHandler()
	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/admin/devices/"+st.DeviceID+"/allow", strings.NewReader(body))
		req.Header.Set(HeaderSecret, th.state.Secret)
		admin.ServeHTTP(rec, req)
		return rec
	}
	if rec := put(`{"allow":["GET /api/../x"]}`); rec.Code != 400 {
		t.Fatalf("a bad rule: %d %s", rec.Code, rec.Body.String())
	}
	if code, _ := send("GET", "/api/v1/memory"); code != http.StatusForbidden {
		t.Fatal("a refused change lifted the limit")
	}
	if rec := put(`{"allow":[]}`); rec.Code != 200 {
		t.Fatalf("lifting the limit: %d %s", rec.Code, rec.Body.String())
	}
	if code, body := send("GET", "/api/v1/memory"); code != 200 || !strings.HasPrefix(body, st.DeviceID+"|") {
		t.Fatalf("after lifting: %d %q", code, body)
	}
	if rec := put(`{"allow":["POST /api/v1/notify/inbound"]}`); rec.Code != 200 {
		t.Fatalf("limiting again: %d", rec.Code)
	}
	if code, _ := send("GET", "/api/v1/memory"); code != http.StatusForbidden {
		t.Fatal("the new limit did not hold")
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/admin/devices/dnosuchdevice/allow", strings.NewReader(`{"allow":[]}`))
	req.Header.Set(HeaderSecret, th.state.Secret)
	admin.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("unknown device: %d", rec.Code)
	}
}

// The limit survives a hub restart: it lives in link.json with the device.
func TestLimitSurvivesRestart(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	path := filepath.Join(t.TempDir(), "link.json")
	th := newTestHub(t, pan.URL, binds[0], path, []string{"127.0.0.1:2"})
	info, _ := th.hub.StartPairingLimited("Work PC", 0, []string{"POST /api/v1/notify/inbound"})
	uri, _ := info.URI()
	st, err := Pair(context.Background(), uri, "", func() conn.Bind { return binds[1] })
	if err != nil {
		t.Fatal(err)
	}
	th.link.Close()

	binds2 := bindtest.NewChannelBinds()
	th2 := newTestHub(t, pan.URL, binds2[0], path, []string{"127.0.0.1:2"})
	devs := th2.hub.Devices()
	if len(devs) != 1 || len(devs[0].Allow) != 1 || devs[0].Allow[0] != "POST /api/v1/notify/inbound" {
		t.Fatalf("after restart: %+v", devs)
	}
	pc, _, err := Connect(context.Background(), st, func() conn.Bind { return binds2[1] })
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if _, err := get(t, pc, "/api/v1/memory", nil); err == nil {
		t.Fatal("the limit was lost in the restart")
	}
}

func TestAdminPairWithLimit(t *testing.T) {
	var hits atomic.Int32
	pan := fakePAN(t, &hits)
	binds := bindtest.NewChannelBinds()
	th := newTestHub(t, pan.URL, binds[0], "", []string{"127.0.0.1:2"})
	admin := th.hub.AdminHandler()
	pair := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/admin/pair", strings.NewReader(body))
		req.Header.Set(HeaderSecret, "s3cret")
		admin.ServeHTTP(rec, req)
		return rec
	}
	if rec := pair(`{"name":"x","allow":["GET /a/../b"]}`); rec.Code != 400 || len(th.hub.pending) != 0 {
		t.Fatalf("bad rule: %d, %d pending", rec.Code, len(th.hub.pending))
	}
	rec := pair(`{"name":"Work PC","allow":["POST /api/v1/notify/inbound"]}`)
	if rec.Code != 200 {
		t.Fatalf("limited code: %d %s", rec.Code, rec.Body.String())
	}
	for _, p := range th.hub.pending {
		if len(p.allow) != 1 {
			t.Fatalf("pending pairing lost its limit: %+v", p)
		}
	}
}
