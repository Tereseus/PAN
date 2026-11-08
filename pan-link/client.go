package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tailscale/wireguard-go/conn"
)

// ClientState is what a paired phone or PC keeps (its own private key never leaves it).
type ClientState struct {
	PrivateKey string     `json:"private_key"`
	HubKey     string     `json:"hub_key"`
	HubIP      netip.Addr `json:"hub_ip"`
	DeviceIP   netip.Addr `json:"device_ip"`
	Endpoints  []string   `json:"endpoints"`
	DeviceID   string     `json:"device_id"`
	Name       string     `json:"name"`
	HubName    string     `json:"hub_name,omitempty"`
}

// KeepaliveSec keeps a phone's NAT mapping open so the hub can answer.
const KeepaliveSec = 25

// BindFactory makes a fresh UDP bind for each try (tests use in-memory binds).
type BindFactory func() conn.Bind

func defaultBinds(f BindFactory) BindFactory {
	if f != nil {
		return f
	}
	return func() conn.Bind { return conn.NewDefaultBind() }
}

func tunnelClient(l *Link, timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return l.Net.DialContext(ctx, network, addr)
		},
		DisableKeepAlives: true,
	}}
}

func hubURL(ip netip.Addr, path string) string {
	return "http://" + netip.AddrPortFrom(ip, TunnelPort).String() + path
}

// Pair uses a pairing code: it connects with the one time key, sends a new permanent
// public key, and returns the state to save. The one time key is useless afterwards.
func Pair(ctx context.Context, uri, name string, binds BindFactory) (*ClientState, error) {
	info, err := ParsePairURI(uri)
	if err != nil {
		return nil, err
	}
	if time.Now().After(info.Expires) {
		return nil, errors.New("this pairing code has expired; make a new one on the computer")
	}
	priv, pub, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	l, _, err := startSpray(ctx, info.OneTime, info.DeviceIP, info.HubKey, info.HubIP, info.Endpoints, binds)
	if err != nil {
		return nil, fmt.Errorf("could not reach the computer: %w", err)
	}
	body, _ := json.Marshal(map[string]string{"public_key": pub, "name": name})
	req, _ := http.NewRequestWithContext(ctx, "POST", hubURL(info.HubIP, "/.pan-link/finish"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := tunnelClient(l, 10*time.Second).Do(req)
	if err != nil {
		l.Close()
		// A code works once and for a few minutes; after that the hub no longer knows
		// its key and stays silent, which looks the same as a computer that is off.
		return nil, fmt.Errorf("could not reach the computer on %s (is it on? a code works only once, so make a new one if this one was used): %w",
			strings.Join(info.Endpoints, ", "), err)
	}
	var out struct {
		DeviceID string `json:"device_id"`
		Name     string `json:"name"`
		Error    string `json:"error"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out)
	resp.Body.Close()
	l.Close()
	if resp.StatusCode != 200 || out.DeviceID == "" {
		return nil, fmt.Errorf("the computer refused pairing: %s", out.Error)
	}
	// The hub swaps in the permanent key just after answering (pairCommitDelay).
	// Waiting a moment saves the first Connect a 5 second handshake retry.
	time.Sleep(700 * time.Millisecond)
	return &ClientState{PrivateKey: priv, HubKey: info.HubKey, HubIP: info.HubIP,
		DeviceIP: info.DeviceIP, Endpoints: info.Endpoints, DeviceID: out.DeviceID,
		Name: out.Name, HubName: info.HubName}, nil
}

// Connect starts the link with the device's permanent key. Its first packets go to all
// known hub addresses at once; it returns once the hub answers, with the address that
// won (home network, IPv6, router or Tailscale, whichever answered first).
func Connect(ctx context.Context, st *ClientState, binds BindFactory) (*Link, string, error) {
	l, _, err := startSpray(ctx, st.PrivateKey, st.DeviceIP, st.HubKey, st.HubIP, st.Endpoints, binds)
	if err != nil {
		return nil, "", err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", hubURL(st.HubIP, "/.pan-link/ping"), nil)
	resp, err := tunnelClient(l, 8*time.Second).Do(req)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode != 200 {
			err = fmt.Errorf("hub answered %d", resp.StatusCode)
		}
	}
	if err != nil {
		l.Close()
		return nil, "", fmt.Errorf("hub not reachable on %s: %w", strings.Join(st.Endpoints, ", "), err)
	}
	ep, err := l.PeerEndpoint(st.HubKey)
	if err != nil {
		ep = "an unknown address"
	}
	return l, ep, nil
}

// Open starts the link like Connect but does not wait for the hub. Its first handshake
// goes to every hub address at once, and later requests (or Rehandshake) reach the hub
// as soon as any path works. Phones use it, since they often start with no network.
func Open(ctx context.Context, st *ClientState, binds BindFactory) (*Link, error) {
	l, _, err := startSpray(ctx, st.PrivateKey, st.DeviceIP, st.HubKey, st.HubIP, st.Endpoints, binds)
	return l, err
}

// ServeLocalProxy forwards every connection on ln (for example 127.0.0.1:0) to PAN on
// the hub, so apps on this device talk to a local port. Blocks until ln closes.
func (l *Link) ServeLocalProxy(ln net.Listener, hubIP netip.Addr) error {
	target := netip.AddrPortFrom(hubIP, TunnelPort)
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			r, err := l.Net.DialContextTCPAddrPort(ctx, target)
			cancel()
			if err != nil {
				return
			}
			defer r.Close()
			done := make(chan struct{}, 2)
			go func() { io.Copy(r, c); r.CloseWrite(); done <- struct{}{} }()
			go func() { io.Copy(c, r); done <- struct{}{} }()
			<-done
			<-done
		}()
	}
}

// LoadClientState and Save keep the client's state file.
func LoadClientState(path string) (*ClientState, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st ClientState
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (st *ClientState) Save(path string) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
