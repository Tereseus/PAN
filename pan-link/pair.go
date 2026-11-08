package link

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// TunnelPort is where the hub answers inside the tunnel. It matches PAN's own port so
// the phone app's paths do not change.
const TunnelPort = 7777

// PairInfo is what the hub's pairing QR carries. The one time key only works until the
// phone sends its own permanent key, or until it expires (10 minutes by default).
type PairInfo struct {
	HubKey    string     // hub public key, base64
	HubIP     netip.Addr // hub tunnel address
	OneTime   string     // one time private key for this phone, base64
	DeviceIP  netip.Addr // the phone's tunnel address
	Endpoints []string   // "host:port" the hub can be reached on, best first
	Expires   time.Time
	HubName   string
}

func b64std2url(s string) (string, error) {
	k, err := keyBytes(s)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(k), nil
}

func b64url2std(s string) (string, error) {
	k, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(k) != 32 {
		return "", errors.New("bad key in pairing code")
	}
	return base64.StdEncoding.EncodeToString(k), nil
}

// URI is the text inside the QR: pan://pair?v=1&h=...&g=...&k=...&a=...&e=...&x=...&n=...
func (p PairInfo) URI() (string, error) {
	h, err := b64std2url(p.HubKey)
	if err != nil {
		return "", fmt.Errorf("hub key: %w", err)
	}
	k, err := b64std2url(p.OneTime)
	if err != nil {
		return "", fmt.Errorf("one time key: %w", err)
	}
	q := url.Values{}
	q.Set("v", "1")
	q.Set("h", h)
	q.Set("g", p.HubIP.String())
	q.Set("k", k)
	q.Set("a", p.DeviceIP.String())
	q.Set("e", strings.Join(p.Endpoints, ","))
	q.Set("x", strconv.FormatInt(p.Expires.Unix(), 10))
	if p.HubName != "" {
		q.Set("n", p.HubName)
	}
	return "pan://pair?" + q.Encode(), nil
}

// ParsePairURI reads the QR text. It does not check the expiry; Pair does.
func ParsePairURI(s string) (PairInfo, error) {
	var p PairInfo
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return p, err
	}
	if u.Scheme != "pan" || u.Host != "pair" {
		return p, errors.New("not a PAN pairing code")
	}
	q := u.Query()
	if q.Get("v") != "1" {
		return p, errors.New("pairing code from a newer PAN, update the app")
	}
	if p.HubKey, err = b64url2std(q.Get("h")); err != nil {
		return p, err
	}
	if p.OneTime, err = b64url2std(q.Get("k")); err != nil {
		return p, err
	}
	if p.HubIP, err = netip.ParseAddr(q.Get("g")); err != nil {
		return p, fmt.Errorf("hub address: %w", err)
	}
	if p.DeviceIP, err = netip.ParseAddr(q.Get("a")); err != nil {
		return p, fmt.Errorf("device address: %w", err)
	}
	for _, e := range strings.Split(q.Get("e"), ",") {
		if e = strings.TrimSpace(e); e != "" {
			if _, err := netip.ParseAddrPort(e); err != nil {
				return p, fmt.Errorf("endpoint %q: %w", e, err)
			}
			p.Endpoints = append(p.Endpoints, e)
		}
	}
	if len(p.Endpoints) == 0 {
		return p, errors.New("pairing code has no hub address")
	}
	x, err := strconv.ParseInt(q.Get("x"), 10, 64)
	if err != nil {
		return p, errors.New("pairing code has no expiry")
	}
	p.Expires = time.Unix(x, 0)
	p.HubName = q.Get("n")
	return p, nil
}
