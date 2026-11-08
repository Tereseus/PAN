package link

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Device is one paired phone or computer.
type Device struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	PublicKey string     `json:"public_key"`
	TunnelIP  netip.Addr `json:"tunnel_ip"`
	Added     time.Time  `json:"added"`
	// Allow limits the device to these requests (allow.go); empty means no limit.
	Allow []string `json:"allow,omitempty"`
}

// HubState is what the hub keeps on disk (link.json in PAN's data folder).
type HubState struct {
	PrivateKey string     `json:"private_key"`
	HubIP      netip.Addr `json:"hub_ip"`
	ListenPort int        `json:"listen_port"`
	Secret     string     `json:"secret"` // shared with PAN only; proves a request came through pan-link
	Name       string     `json:"name,omitempty"`
	Devices    []Device   `json:"devices"`

	// The address record (record.go): the Ed25519 seed that signs it and the key that
	// encrypts it, both base64. NewHub makes them when they are missing.
	RecordSeed   string `json:"record_seed,omitempty"`
	RecordSecret string `json:"record_secret,omitempty"`
}

// DefaultHubIP is the hub's address inside the tunnel. The tunnel lives inside the
// programs' own network stacks, so it can never clash with the home network.
var DefaultHubIP = netip.MustParseAddr("10.77.0.1")

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// NewDeviceID is a random id. It never starts with "dev-": PAN's client manager
// accepts any token with that prefix (client-manager.js), so keep clear of it.
func NewDeviceID() string { return "d" + randomHex(6) }

// LoadOrCreateHubState reads the state file, or makes a new hub identity if there is none.
func LoadOrCreateHubState(path string, listenPort int) (*HubState, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		var st HubState
		if err := json.Unmarshal(b, &st); err != nil {
			return nil, err
		}
		if _, err := keyBytes(st.PrivateKey); err != nil {
			return nil, err
		}
		if st.Secret == "" {
			return nil, errors.New("link state has no secret")
		}
		return &st, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	priv, _, err := GenerateKey()
	if err != nil {
		return nil, err
	}
	st := &HubState{PrivateKey: priv, HubIP: DefaultHubIP, ListenPort: listenPort, Secret: randomHex(32)}
	return st, st.Save(path)
}

// endpointsFile is where the hub keeps each device's last address: link-endpoints.json
// next to link.json. It is a separate file so that link.json, which PAN reads, is not
// rewritten every time a phone changes networks.
func endpointsFile(statePath string) string {
	return strings.TrimSuffix(statePath, filepath.Ext(statePath)) + "-endpoints.json"
}

// loadEndpoints reads device id -> address. A missing or damaged file only costs the
// head start after a restart, so it reads as empty.
func loadEndpoints(path string) map[string]string {
	out := map[string]string{}
	if path == "" {
		return out
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	if json.Unmarshal(b, &out) != nil || out == nil {
		return map[string]string{}
	}
	return out
}

func saveEndpoints(path string, m map[string]string) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Save writes the state atomically, readable by the owner only where the OS allows.
func (st *HubState) Save(path string) error {
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
