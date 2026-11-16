//go:build !android

package link

import "github.com/tailscale/wireguard-go/conn"

// AndroidSafe returns b unchanged; on Android it turns off UDP receive offload, which
// wireguard-go mishandles there (bind_android.go).
func AndroidSafe(b conn.Bind) conn.Bind { return b }

// NewDefaultBind is WireGuard's normal UDP bind (on Android, made safe by AndroidSafe).
func NewDefaultBind() conn.Bind { return conn.NewDefaultBind() }
