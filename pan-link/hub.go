package link

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Header names the hub adds before a request reaches PAN. PAN trusts them only when the
// secret matches, which only pan-link and PAN know (it lives in PAN's data folder).
const (
	HeaderDevice     = "X-PAN-Device"
	HeaderDeviceName = "X-PAN-Device-Name"
	HeaderSecret     = "X-PAN-Link-Secret"
)

// DefaultPairTTL is how long a pairing QR works.
const DefaultPairTTL = 10 * time.Minute

type pendingPair struct {
	oneTimePub string
	name       string
	expires    time.Time
}

// Hub forwards tunnel traffic to PAN on the computer itself, says which device sent it,
// and pairs new devices.
type Hub struct {
	link      *Link
	backend   *url.URL
	state     *HubState
	statePath string // "" keeps state in memory only (tests)
	hubPub    string

	// Endpoints returns the addresses a new device should try, best first. Set by the
	// program (home address, public address with an opened port, IPv6).
	Endpoints func() []string
	// OnError hears about failures that happen after an answer was sent (optional).
	OnError func(error)
	now     func() time.Time

	mu      sync.Mutex
	devices map[netip.Addr]Device
	pending map[netip.Addr]pendingPair

	endpointsPath string            // device addresses kept across restarts ("" = not kept)
	remembered    map[string]string // device id -> address, as last written
	kickKeys      []string          // devices to reach out to once Serve is listening
}

// NewHub wraps a running link and loads the paired devices into it. backend is PAN on
// this computer, for example "http://127.0.0.1:7777". Devices with an address saved by
// RememberEndpoints get it back, and Serve reaches out to them first.
func NewHub(l *Link, backend string, st *HubState, statePath string) (*Hub, error) {
	u, err := url.Parse(backend)
	if err != nil {
		return nil, err
	}
	if st.Secret == "" {
		return nil, errors.New("empty link secret")
	}
	pub, err := PublicKey(st.PrivateKey)
	if err != nil {
		return nil, err
	}
	h := &Hub{link: l, backend: u, state: st, statePath: statePath, hubPub: pub,
		Endpoints: func() []string { return nil }, now: time.Now,
		devices: map[netip.Addr]Device{}, pending: map[netip.Addr]pendingPair{}}
	if statePath != "" {
		h.endpointsPath = endpointsFile(statePath)
	}
	h.remembered = loadEndpoints(h.endpointsPath)
	for _, d := range st.Devices {
		p := Peer{PublicKey: d.PublicKey, TunnelIP: d.TunnelIP}
		if ep, err := netip.ParseAddrPort(h.remembered[d.ID]); err == nil {
			p.Endpoint = ep.String()
		}
		err := l.AddPeer(p)
		if err != nil && p.Endpoint != "" {
			p.Endpoint = "" // a bad saved address must never keep the hub from starting
			err = l.AddPeer(p)
		}
		if err != nil {
			return nil, fmt.Errorf("device %s: %w", d.ID, err)
		}
		if p.Endpoint != "" {
			h.kickKeys = append(h.kickKeys, d.PublicKey)
		}
		h.devices[d.TunnelIP] = d
	}
	return h, nil
}

// RememberEndpoints saves the address each device last used (link-endpoints.json next to
// link.json), so that after a restart the hub can reach out first. The program calls it
// every few seconds and when it stops; it writes only when something changed.
func (h *Hub) RememberEndpoints() error {
	if h.endpointsPath == "" {
		return nil
	}
	eps, err := h.link.peerEndpoints()
	if err != nil {
		return err
	}
	cur := map[string]string{}
	h.mu.Lock()
	for _, d := range h.devices {
		if pub, err := keyHex(d.PublicKey); err == nil && eps[pub] != "" {
			cur[d.ID] = eps[pub]
		}
	}
	same := maps.Equal(cur, h.remembered)
	h.mu.Unlock()
	if same {
		return nil
	}
	if err := saveEndpoints(h.endpointsPath, cur); err != nil {
		return err
	}
	h.mu.Lock()
	h.remembered = cur
	h.mu.Unlock()
	return nil
}

func (h *Hub) save() error {
	h.state.Devices = h.state.Devices[:0]
	for _, d := range h.devices {
		h.state.Devices = append(h.state.Devices, d)
	}
	sort.Slice(h.state.Devices, func(i, j int) bool {
		return h.state.Devices[i].TunnelIP.Less(h.state.Devices[j].TunnelIP)
	})
	if h.statePath == "" {
		return nil
	}
	return h.state.Save(h.statePath)
}

// nextIP finds a free tunnel address after the hub's. Caller holds h.mu.
func (h *Hub) nextIP() (netip.Addr, error) {
	ip := h.state.HubIP
	for i := 0; i < 65000; i++ {
		ip = ip.Next()
		if !ip.IsValid() {
			break
		}
		if _, used := h.devices[ip]; used {
			continue
		}
		if _, used := h.pending[ip]; used {
			continue
		}
		return ip, nil
	}
	return netip.Addr{}, errors.New("no free tunnel address")
}

// StartPairing makes a one time key for a new device and returns what its QR shows.
func (h *Hub) StartPairing(name string, ttl time.Duration) (PairInfo, error) {
	if ttl <= 0 {
		ttl = DefaultPairTTL
	}
	priv, pub, err := GenerateKey()
	if err != nil {
		return PairInfo{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	ip, err := h.nextIP()
	if err != nil {
		return PairInfo{}, err
	}
	if err := h.link.AddPeer(Peer{PublicKey: pub, TunnelIP: ip}); err != nil {
		return PairInfo{}, err
	}
	exp := h.now().Add(ttl)
	h.pending[ip] = pendingPair{oneTimePub: pub, name: name, expires: exp}
	return PairInfo{HubKey: h.hubPub, HubIP: h.state.HubIP, OneTime: priv, DeviceIP: ip,
		Endpoints: h.Endpoints(), Expires: exp, HubName: h.state.Name}, nil
}

// ExpirePending drops pairing codes past their time. The program calls it every so often.
func (h *Hub) ExpirePending() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ip, p := range h.pending {
		if h.now().After(p.expires) {
			h.link.RemovePeer(p.oneTimePub)
			delete(h.pending, ip)
		}
	}
}

// pairCommitDelay lets the answer to /.pan-link/finish travel back on the one time key
// before that key is swapped out (after the swap, packets to that address go to the
// new key, which the phone only starts using once it has the answer).
var pairCommitDelay = 300 * time.Millisecond

// claimPairing checks a finish request and takes the pairing out of the pending list,
// so the same code can never be finished twice. commitPairing does the key swap.
func (h *Hub) claimPairing(from netip.Addr, permanentPub, name string) (Device, string, error) {
	if _, err := keyBytes(permanentPub); err != nil {
		return Device{}, "", err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p, ok := h.pending[from]
	if !ok {
		return Device{}, "", errors.New("no pairing in progress for this address")
	}
	if h.now().After(p.expires) {
		delete(h.pending, from)
		// Drop the key after the answer has gone back on it (see pairCommitDelay).
		go func(pub string) { time.Sleep(pairCommitDelay); h.link.RemovePeer(pub) }(p.oneTimePub)
		return Device{}, "", errors.New("pairing code expired")
	}
	if permanentPub == p.oneTimePub {
		return Device{}, "", errors.New("send a new key, not the one time key")
	}
	for _, d := range h.devices {
		if d.PublicKey == permanentPub {
			return Device{}, "", errors.New("key already paired")
		}
	}
	delete(h.pending, from)
	if name == "" {
		name = p.name
	}
	d := Device{ID: NewDeviceID(), Name: name, PublicKey: permanentPub, TunnelIP: from, Added: h.now().UTC()}
	return d, p.oneTimePub, nil
}

// commitPairing swaps the one time key for the device's permanent key and saves.
func (h *Hub) commitPairing(d Device, oneTimePub string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.link.RemovePeer(oneTimePub); err != nil {
		return err
	}
	if err := h.link.AddPeer(Peer{PublicKey: d.PublicKey, TunnelIP: d.TunnelIP}); err != nil {
		return err
	}
	h.devices[d.TunnelIP] = d
	return h.save()
}

// RemoveDevice unpairs a device. Its session ends at once.
func (h *Hub) RemoveDevice(id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ip, d := range h.devices {
		if d.ID == id {
			if err := h.link.RemovePeer(d.PublicKey); err != nil {
				return err
			}
			delete(h.devices, ip)
			return h.save()
		}
	}
	return errors.New("no such device")
}

// Devices lists the paired devices.
func (h *Hub) Devices() []Device {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Device, 0, len(h.devices))
	for _, d := range h.devices {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TunnelIP.Less(out[j].TunnelIP) })
	return out
}

func remoteAddr(r *http.Request) netip.Addr {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func (h *Hub) lookup(ip netip.Addr) (Device, bool, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	d, ok := h.devices[ip]
	_, pend := h.pending[ip]
	return d, ok, pend
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// TunnelHandler is what devices reach inside the tunnel. /.pan-link/ is answered by
// pan-link itself; everything else goes to PAN, for paired devices only.
func (h *Hub) TunnelHandler() http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(h.backend)
			r.Out.Host = r.In.Host
			// Never pass on identity headers a device sent itself.
			r.Out.Header.Del(HeaderDevice)
			r.Out.Header.Del(HeaderDeviceName)
			r.Out.Header.Del(HeaderSecret)
			if d, ok, _ := h.lookup(remoteAddr(r.In)); ok {
				r.Out.Header.Set(HeaderDevice, d.ID)
				r.Out.Header.Set(HeaderDeviceName, d.Name)
				r.Out.Header.Set(HeaderSecret, h.state.Secret)
			}
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := remoteAddr(r)
		_, paired, pending := h.lookup(ip)
		switch {
		case r.URL.Path == "/.pan-link/ping" && (paired || pending):
			writeJSON(w, 200, map[string]any{"ok": true, "paired": paired})
		case r.URL.Path == "/.pan-link/finish" && r.Method == http.MethodPost && pending:
			var body struct {
				PublicKey string `json:"public_key"`
				Name      string `json:"name"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
				writeJSON(w, 400, map[string]string{"error": "bad request"})
				return
			}
			d, oneTimePub, err := h.claimPairing(ip, body.PublicKey, body.Name)
			if err != nil {
				writeJSON(w, 409, map[string]string{"error": err.Error()})
				return
			}
			w.Header().Set("Connection", "close")
			writeJSON(w, 200, map[string]string{"device_id": d.ID, "name": d.Name})
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			go func() {
				time.Sleep(pairCommitDelay)
				if err := h.commitPairing(d, oneTimePub); err != nil && h.OnError != nil {
					h.OnError(fmt.Errorf("pairing %s: %w", d.ID, err))
				}
			}()
		case strings.HasPrefix(r.URL.Path, "/.pan-link/"):
			http.Error(w, "not allowed", http.StatusForbidden)
		case paired:
			proxy.ServeHTTP(w, r)
		default:
			http.Error(w, "unknown device", http.StatusForbidden)
		}
	})
}

// AdminHandler is for PAN and PAN Setup on this computer only. Every call needs the link
// secret in X-PAN-Link-Secret, which also stops web pages from calling it (a custom
// header forces a CORS preflight that this handler never approves).
func (h *Hub) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/pair", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name       string `json:"name"`
			TTLMinutes int    `json:"ttl_minutes"`
		}
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		info, err := h.StartPairing(body.Name, time.Duration(body.TTLMinutes)*time.Minute)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		uri, err := info.URI()
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"uri": uri, "expires": info.Expires.UTC(), "device_ip": info.DeviceIP})
	})
	mux.HandleFunc("GET /admin/devices", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, h.Devices())
	})
	mux.HandleFunc("DELETE /admin/devices/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := h.RemoveDevice(r.PathValue("id")); err != nil {
			writeJSON(w, 404, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /admin/status", func(w http.ResponseWriter, r *http.Request) {
		port, _ := h.link.ListenPort()
		writeJSON(w, 200, map[string]any{"hub_key": h.hubPub, "hub_ip": h.state.HubIP,
			"listen_port": port, "endpoints": h.Endpoints(), "devices": len(h.Devices())})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(HeaderSecret)
		if subtle.ConstantTimeCompare([]byte(got), []byte(h.state.Secret)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// Serve accepts connections on the hub's tunnel address and blocks until it fails.
// WebSocket upgrades pass through (httputil.ReverseProxy handles them). Once it is
// listening, it reaches out to the devices whose last address it remembered.
func (h *Hub) Serve() error {
	ln, err := h.link.Net.ListenTCPAddrPort(netip.AddrPortFrom(h.link.TunnelIP, TunnelPort))
	if err != nil {
		return err
	}
	h.mu.Lock()
	kick := h.kickKeys
	h.kickKeys = nil
	h.mu.Unlock()
	for _, k := range kick {
		h.link.Kick(k)
	}
	srv := &http.Server{Handler: h.TunnelHandler(), ReadHeaderTimeout: 15 * time.Second}
	return srv.Serve(ln)
}

// ServeAdmin serves the admin API on a local listener (for example 127.0.0.1:7792).
func (h *Hub) ServeAdmin(ln net.Listener) error {
	srv := &http.Server{Handler: h.AdminHandler(), ReadHeaderTimeout: 15 * time.Second}
	return srv.Serve(ln)
}
