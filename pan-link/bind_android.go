package link

import (
	"golang.org/x/sys/unix"

	"github.com/tailscale/wireguard-go/conn"
)

// udpGRO is the UDP_GRO socket option (linux/udp.h).
const udpGRO = 104

// noGROBind turns off UDP receive offload (GRO) on the link's sockets each time they open.
//
// wireguard-go's StdNetBind asks the kernel for GRO on every Linux-kernel system, Android
// included, but reads the size of the merged packets only when GOOS is "linux" (its
// control_linux.go is built for linux && !android). On a phone, packets the kernel merged
// arrive as one datagram that holds several WireGuard packets, fail to decrypt and are
// dropped. A lone packet is never merged, so small requests worked while every burst was
// lost: the hub's 85 MB APK came at about 1 KB/s through the phone app's link (Nov 15
// 2026), and the same pan-link code built for GOOS=linux on the same tablet took 12 s.
type noGROBind struct{ conn.Bind }

func (b noGROBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.Bind.Open(port)
	if err != nil {
		return fns, actual, err
	}
	type socketFds interface {
		PeekLookAtSocketFd4() (int, error)
		PeekLookAtSocketFd6() (int, error)
	}
	if s, ok := b.Bind.(socketFds); ok {
		for _, peek := range []func() (int, error){s.PeekLookAtSocketFd4, s.PeekLookAtSocketFd6} {
			if fd, err := peek(); err == nil && fd >= 0 {
				unix.SetsockoptInt(fd, unix.IPPROTO_UDP, udpGRO, 0)
			}
		}
	}
	return fns, actual, nil
}

// AndroidSafe wraps a WireGuard bind so that it works on Android (see noGROBind).
func AndroidSafe(b conn.Bind) conn.Bind {
	if _, ok := b.(noGROBind); ok {
		return b
	}
	return noGROBind{b}
}

// NewDefaultBind is WireGuard's normal UDP bind, safe to use on Android (see noGROBind).
func NewDefaultBind() conn.Bind { return AndroidSafe(conn.NewDefaultBind()) }
