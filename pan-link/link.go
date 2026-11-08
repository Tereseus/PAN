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
