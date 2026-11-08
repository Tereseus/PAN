// Package link is PAN Link: plain WireGuard running inside the program, with its own
// network stack (wireguard-go netstack), so it installs no system VPN driver and does
// not fight other VPNs. Hub and spokes: every phone and PC is a peer of the hub.
//
// Design: docs/INSTALL-PLAN.md, section "PAN Link".
package link

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"dev.pan/link/netstack"
	"github.com/tailscale/wireguard-go/conn"
	"github.com/tailscale/wireguard-go/device"
	"golang.org/x/crypto/curve25519"
)

// MTU leaves room for WireGuard's overhead on mobile networks.
const MTU = 1280

// Peer is one device the link will talk to.
type Peer struct {
	PublicKey    string     // base64, as WireGuard prints it
	TunnelIP     netip.Addr // the only source address this peer may use inside the tunnel
	Endpoint     string     // optional "host:port"; the hub leaves it empty and learns it
	PresharedKey string     // optional base64
	KeepaliveSec int        // optional; phones behind NAT should send one about every 25 s
}

// Config is everything needed to start a link.
type Config struct {
	PrivateKey string     // base64
	TunnelIP   netip.Addr // this device's address inside the tunnel
	ListenPort int        // UDP port; 0 picks any (spokes)
	Peers      []Peer
	Bind       conn.Bind // nil means real UDP sockets; tests pass an in-memory bind
	Verbose    bool
}

// Link is a running WireGuard device plus its private network stack.
type Link struct {
	Net      *netstack.Net
	TunnelIP netip.Addr
	dev      *device.Device
	spray    *sprayBind // a device's link to its hub; nil on the hub
}

// GenerateKey makes a WireGuard key pair, both halves base64.
func GenerateKey() (private, public string, err error) {
	var k [32]byte
	if _, err = rand.Read(k[:]); err != nil {
		return "", "", err
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	pub, err := curve25519.X25519(k[:], curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(k[:]), base64.StdEncoding.EncodeToString(pub), nil
}

// PublicKey returns the public half of a base64 private key.
func PublicKey(private string) (string, error) {
	k, err := keyBytes(private)
	if err != nil {
		return "", err
	}
	pub, err := curve25519.X25519(k, curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(pub), nil
}

func keyBytes(b64 string) ([]byte, error) {
	k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("bad key: %w", err)
	}
	if len(k) != 32 {
		return nil, errors.New("bad key: not 32 bytes")
	}
	return k, nil
}

func keyHex(b64 string) (string, error) {
	k, err := keyBytes(b64)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(k), nil
}

// uapi builds the WireGuard configuration text (keys in hex, one setting per line).
func uapi(cfg Config) (string, error) {
	var b strings.Builder
	priv, err := keyHex(cfg.PrivateKey)
	if err != nil {
		return "", fmt.Errorf("private key: %w", err)
	}
	fmt.Fprintf(&b, "private_key=%s\n", priv)
	if cfg.ListenPort > 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", cfg.ListenPort)
	}
	for i, p := range cfg.Peers {
		pc, err := peerConf(p)
		if err != nil {
			return "", fmt.Errorf("peer %d: %w", i, err)
		}
		b.WriteString(pc)
	}
	return b.String(), nil
}

// peerConf is the configuration text for one peer. It sets the peer's address exactly,
// so updating a peer never leaves an old address behind.
func peerConf(p Peer) (string, error) {
	var b strings.Builder
	pub, err := keyHex(p.PublicKey)
	if err != nil {
		return "", err
	}
	if !p.TunnelIP.IsValid() {
		return "", errors.New("no tunnel address")
	}
	fmt.Fprintf(&b, "public_key=%s\n", pub)
	if p.PresharedKey != "" {
		psk, err := keyHex(p.PresharedKey)
		if err != nil {
			return "", fmt.Errorf("preshared key: %w", err)
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	if p.Endpoint != "" {
		fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
	}
	if p.KeepaliveSec > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.KeepaliveSec)
	}
	// One address per peer. WireGuard drops any packet from this key with another
	// source address, so the tunnel address proves which device is calling.
	b.WriteString("replace_allowed_ips=true\n")
	fmt.Fprintf(&b, "allowed_ip=%s\n", netip.PrefixFrom(p.TunnelIP, p.TunnelIP.BitLen()))
	return b.String(), nil
}

// Start brings a link up.
func Start(cfg Config) (*Link, error) {
	if !cfg.TunnelIP.IsValid() {
		return nil, errors.New("no tunnel address")
	}
	conf, err := uapi(cfg)
	if err != nil {
		return nil, err
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{cfg.TunnelIP}, nil, MTU)
	if err != nil {
		return nil, err
	}
	bind := cfg.Bind
	if bind == nil {
		bind = conn.NewDefaultBind()
	}
	bind = &quietBind{Bind: bind}
	level := device.LogLevelError
	if cfg.Verbose {
		level = device.LogLevelVerbose
	}
	logger := device.NewLogger(level, "pan-link: ")
	errorf := logger.Errorf
	logger.Errorf = func(format string, args ...any) {
		// On the hub every device peer starts with no address: devices always call in
		// first. wireguard-go still tries to reach one that hasn't yet and logs this as an
		// error, which is expected here.
		if strings.Contains(fmt.Sprintf(format, args...), "no known endpoint for peer") {
			return
		}
		errorf(format, args...)
	}
	dev := device.NewDevice(tunDev, bind, logger)
	if err := dev.IpcSet(conf); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &Link{Net: tnet, TunnelIP: cfg.TunnelIP, dev: dev}, nil
}

// SetPeers replaces the whole peer list. Every peer's session restarts, so prefer
// AddPeer and RemovePeer for single changes.
func (l *Link) SetPeers(peers []Peer) error {
	var b strings.Builder
	b.WriteString("replace_peers=true\n")
	for i, p := range peers {
		pc, err := peerConf(p)
		if err != nil {
			return fmt.Errorf("peer %d: %w", i, err)
		}
		b.WriteString(pc)
	}
	return l.dev.IpcSet(b.String())
}

// AddPeer adds a peer, or updates it if its key is already there. Other peers keep
// their sessions.
func (l *Link) AddPeer(p Peer) error {
	pc, err := peerConf(p)
	if err != nil {
		return err
	}
	return l.dev.IpcSet(pc)
}

// RemovePeer drops a peer by public key. Its session ends at once.
func (l *Link) RemovePeer(publicKey string) error {
	pub, err := keyHex(publicKey)
	if err != nil {
		return err
	}
	return l.dev.IpcSet("public_key=" + pub + "\nremove=true\n")
}

// Kick starts a handshake with a peer now, at the address the link has for it, instead
// of waiting for the peer to send first. The hub uses it after a restart, so a device
// that stayed connected does not wait about 15 s for WireGuard to try again on its own.
func (l *Link) Kick(publicKey string) error {
	p, err := l.peer(publicKey)
	if err != nil {
		return err
	}
	p.SendKeepalive() // with no session yet, this sends a handshake first
	return nil
}

// Rehandshake starts a new handshake with a peer now, even while a session exists. On a
// device it goes to every known hub address (sprayBind), so after a network change the
// link moves to whichever path answers instead of waiting for WireGuard's own timers.
//
// WireGuard makes at most one handshake every 5 s (device.RekeyTimeout). When it made one
// less than 5 s ago that is still unanswered, as when a phone had no network for a while
// and WireGuard kept trying into nothing, that same one goes out again on every path:
// the hub never saw it, so it accepts it. When it was answered, a new one follows as soon
// as WireGuard allows, since that session may be on the path the phone just left.
func (l *Link) Rehandshake(publicKey string) error {
	p, err := l.peer(publicKey)
	if err != nil {
		return err
	}
	if l.spray == nil {
		return p.SendHandshakeInitiation(false)
	}
	before := l.spray.lastInitTime()
	if err := p.SendHandshakeInitiation(false); err != nil {
		return err
	}
	if !l.spray.lastInitTime().Equal(before) {
		return nil // a new one went out, to every address
	}
	if hs, err := l.LastHandshake(publicKey); err == nil && hs.After(before) {
		wait := time.Until(before.Add(device.RekeyTimeout)) + 50*time.Millisecond
		time.AfterFunc(wait, func() { p.SendHandshakeInitiation(false) })
		return nil
	}
	l.spray.respray()
	return nil
}

func (l *Link) peer(publicKey string) (*device.Peer, error) {
	k, err := keyBytes(publicKey)
	if err != nil {
		return nil, err
	}
	var pk device.NoisePublicKey
	copy(pk[:], k)
	p := l.dev.LookupPeer(pk)
	if p == nil {
		return nil, errors.New("no such peer")
	}
	return p, nil
}

// peerEndpoints maps each peer's public key (hex, as WireGuard's config text prints it)
// to the address WireGuard currently uses for it.
func (l *Link) peerEndpoints() (map[string]string, error) {
	conf, err := l.dev.IpcGet()
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	cur := ""
	for _, line := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(line, "public_key="); ok {
			cur = v
			continue
		}
		if v, ok := strings.CutPrefix(line, "endpoint="); ok && cur != "" {
			out[cur] = v
		}
	}
	return out, nil
}

// LastHandshake is when the link last finished a handshake with a peer (zero if never).
// While a link carries traffic or keepalives, WireGuard renews it every 2 minutes.
func (l *Link) LastHandshake(publicKey string) (time.Time, error) {
	pub, err := keyHex(publicKey)
	if err != nil {
		return time.Time{}, err
	}
	conf, err := l.dev.IpcGet()
	if err != nil {
		return time.Time{}, err
	}
	in := false
	var sec, nsec int64
	for _, line := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(line, "public_key="); ok {
			in = v == pub
			continue
		}
		if !in {
			continue
		}
		if v, ok := strings.CutPrefix(line, "last_handshake_time_sec="); ok {
			fmt.Sscanf(v, "%d", &sec)
		} else if v, ok := strings.CutPrefix(line, "last_handshake_time_nsec="); ok {
			fmt.Sscanf(v, "%d", &nsec)
		}
	}
	if sec == 0 && nsec == 0 {
		return time.Time{}, nil
	}
	return time.Unix(sec, nsec), nil
}

// ListenPort is the UDP port the link actually listens on (useful when started with 0).
func (l *Link) ListenPort() (int, error) {
	conf, err := l.dev.IpcGet()
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(line, "listen_port="); ok {
			var port int
			_, err := fmt.Sscanf(v, "%d", &port)
			return port, err
		}
	}
	return 0, errors.New("no listen port")
}

// Close shuts the link down.
func (l *Link) Close() { l.dev.Close() }
