// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package net

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// If the ifindex is zero, interfaceTable returns mappings of all
// network interfaces. Otherwise it returns a mapping of a specific
// interface.
func interfaceTable(ifindex int) ([]Interface, error) {
	if runtime.GOOS == "android" {
		return interfaceTableAndroid(ifindex)
	}
	tab, err := syscall.NetlinkRIB(syscall.RTM_GETLINK, syscall.AF_UNSPEC)
	if err != nil {
		return nil, os.NewSyscallError("netlinkrib", err)
	}
	msgs, err := syscall.ParseNetlinkMessage(tab)
	if err != nil {
		return nil, os.NewSyscallError("parsenetlinkmessage", err)
	}
	var ift []Interface
loop:
	for _, m := range msgs {
		switch m.Header.Type {
		case syscall.NLMSG_DONE:
			break loop
		case syscall.RTM_NEWLINK:
			ifim := (*syscall.IfInfomsg)(unsafe.Pointer(&m.Data[0]))
			if ifindex == 0 || ifindex == int(ifim.Index) {
				attrs, err := syscall.ParseNetlinkRouteAttr(&m)
				if err != nil {
					return nil, os.NewSyscallError("parsenetlinkrouteattr", err)
				}
				ift = append(ift, *newLink(ifim, attrs))
				if ifindex == int(ifim.Index) {
					break loop
				}
			}
		}
	}
	return ift, nil
}

// interfaceTableAndroid reads /proc/net/if_inet6 and /proc/net/dev to
// enumerate interfaces without netlink (blocked by SELinux on Android 14+).
func interfaceTableAndroid(ifindex int) ([]Interface, error) {
	// Read addresses first to discover interface indices
	addrs, err := interfaceAddrTableAndroid(nil)
	if err != nil {
		return nil, err
	}

	// Collect unique interfaces from addresses
	seen := map[int]bool{}
	var ift []Interface
	for _, a := range addrs {
		ipn, ok := a.(*IPNet)
		if !ok {
			continue
		}
		_ = ipn // addresses collected separately

	}

	// Parse /proc/net/dev for interface names and stats
	fd, err := open("/proc/net/dev")
	if err != nil {
		return nil, err
	}
	defer fd.close()

	fd.readLine() // skip header line 1
	fd.readLine() // skip header line 2

	for l, ok := fd.readLine(); ok; l, ok = fd.readLine() {
		f := splitAtBytes(l, " :\r\t\n")
		if len(f) < 1 {
			continue
		}
		name := f[0]
		if name == "" {
			continue
		}

		// Use ioctl to get interface index and flags
		ifreq := [40]byte{}
		copy(ifreq[:], name)

		sock, serr := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0)
		if serr != nil {
			continue
		}

		// SIOCGIFINDEX = 0x8933
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x8933, uintptr(unsafe.Pointer(&ifreq)))
		if errno != 0 {
			syscall.Close(sock)
			continue
		}
		idx := int(*(*int32)(unsafe.Pointer(&ifreq[16])))

		if ifindex != 0 && idx != ifindex {
			syscall.Close(sock)
			continue
		}
		if seen[idx] {
			syscall.Close(sock)
			continue
		}
		seen[idx] = true

		ifi := Interface{Index: idx, Name: name}

		// SIOCGIFFLAGS = 0x8913
		copy(ifreq[:], name)
		for i := len(name); i < 16; i++ {
			ifreq[i] = 0
		}
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x8913, uintptr(unsafe.Pointer(&ifreq)))
		if errno == 0 {
			flags := *(*uint16)(unsafe.Pointer(&ifreq[16]))
			ifi.Flags = linkFlags(uint32(flags))
		}

		// SIOCGIFMTU = 0x8921
		copy(ifreq[:], name)
		for i := len(name); i < 16; i++ {
			ifreq[i] = 0
		}
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x8921, uintptr(unsafe.Pointer(&ifreq)))
		if errno == 0 {
			ifi.MTU = int(*(*int32)(unsafe.Pointer(&ifreq[16])))
		}

		// SIOCGIFHWADDR = 0x8927
		copy(ifreq[:], name)
		for i := len(name); i < 16; i++ {
			ifreq[i] = 0
		}
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x8927, uintptr(unsafe.Pointer(&ifreq)))
		if errno == 0 {
			// Hardware address starts at offset 18 (sa_data in struct sockaddr)
			hw := make([]byte, 6)
			copy(hw, ifreq[18:24])
			nonzero := false
			for _, b := range hw {
				if b != 0 {
					nonzero = true
					break
				}
			}
			if nonzero {
				ifi.HardwareAddr = hw
			}
		}

		syscall.Close(sock)
		ift = append(ift, ifi)

		if ifindex != 0 && idx == ifindex {
			break
		}
	}
	return ift, nil
}

const (
	// See linux/if_arp.h.
	// Note that Linux doesn't support IPv4 over IPv6 tunneling.
	sysARPHardwareIPv4IPv4 = 768 // IPv4 over IPv4 tunneling
	sysARPHardwareIPv6IPv6 = 769 // IPv6 over IPv6 tunneling
	sysARPHardwareIPv6IPv4 = 776 // IPv6 over IPv4 tunneling
	sysARPHardwareGREIPv4  = 778 // any over GRE over IPv4 tunneling
	sysARPHardwareGREIPv6  = 823 // any over GRE over IPv6 tunneling
)

func newLink(ifim *syscall.IfInfomsg, attrs []syscall.NetlinkRouteAttr) *Interface {
	ifi := &Interface{Index: int(ifim.Index), Flags: linkFlags(ifim.Flags)}
	for _, a := range attrs {
		switch a.Attr.Type {
		case syscall.IFLA_ADDRESS:
			// We never return any /32 or /128 IP address
			// prefix on any IP tunnel interface as the
			// hardware address.
			switch len(a.Value) {
			case IPv4len:
				switch ifim.Type {
				case sysARPHardwareIPv4IPv4, sysARPHardwareGREIPv4, sysARPHardwareIPv6IPv4:
					continue
				}
			case IPv6len:
				switch ifim.Type {
				case sysARPHardwareIPv6IPv6, sysARPHardwareGREIPv6:
					continue
				}
			}
			var nonzero bool
			for _, b := range a.Value {
				if b != 0 {
					nonzero = true
					break
				}
			}
			if nonzero {
				ifi.HardwareAddr = a.Value[:]
			}
		case syscall.IFLA_IFNAME:
			ifi.Name = string(a.Value[:len(a.Value)-1])
		case syscall.IFLA_MTU:
			ifi.MTU = int(*(*uint32)(unsafe.Pointer(&a.Value[:4][0])))
		}
	}
	return ifi
}

func linkFlags(rawFlags uint32) Flags {
	var f Flags
	if rawFlags&syscall.IFF_UP != 0 {
		f |= FlagUp
	}
	if rawFlags&syscall.IFF_RUNNING != 0 {
		f |= FlagRunning
	}
	if rawFlags&syscall.IFF_BROADCAST != 0 {
		f |= FlagBroadcast
	}
	if rawFlags&syscall.IFF_LOOPBACK != 0 {
		f |= FlagLoopback
	}
	if rawFlags&syscall.IFF_POINTOPOINT != 0 {
		f |= FlagPointToPoint
	}
	if rawFlags&syscall.IFF_MULTICAST != 0 {
		f |= FlagMulticast
	}
	return f
}

// If the ifi is nil, interfaceAddrTable returns addresses for all
// network interfaces. Otherwise it returns addresses for a specific
// interface.
func interfaceAddrTable(ifi *Interface) ([]Addr, error) {
	if runtime.GOOS == "android" {
		return interfaceAddrTableAndroid(ifi)
	}
	tab, err := syscall.NetlinkRIB(syscall.RTM_GETADDR, syscall.AF_UNSPEC)
	if err != nil {
		return nil, os.NewSyscallError("netlinkrib", err)
	}
	msgs, err := syscall.ParseNetlinkMessage(tab)
	if err != nil {
		return nil, os.NewSyscallError("parsenetlinkmessage", err)
	}
	ifat, err := addrTable(ifi, msgs)
	if err != nil {
		return nil, err
	}
	return ifat, nil
}

// interfaceAddrTableAndroid reads /proc/net/if_inet6 and uses ioctl
// for IPv4 addresses without netlink.
func interfaceAddrTableAndroid(ifi *Interface) ([]Addr, error) {
	var ifat []Addr

	// Read IPv6 addresses from /proc/net/if_inet6
	fd6, err := open("/proc/net/if_inet6")
	if err == nil {
		defer fd6.close()
		b := make([]byte, IPv6len)
		for l, ok := fd6.readLine(); ok; l, ok = fd6.readLine() {
			f := splitAtBytes(l, " \r\t\n")
			if len(f) < 6 {
				continue
			}
			if ifi != nil && f[5] != ifi.Name {
				continue
			}
			for i := 0; i+1 < len(f[0]) && i/2 < IPv6len; i += 2 {
				b[i/2], _ = xtoi2(f[0][i:i+2], 0)
			}
			prefixlen, _, _ := xtoi(f[2])
			ip := make(IP, IPv6len)
			copy(ip, b)
			ifat = append(ifat, &IPNet{
				IP:   ip,
				Mask: CIDRMask(prefixlen, 8*IPv6len),
			})
		}
	}

	// Read IPv4 addresses using ioctl SIOCGIFADDR per interface
	// First get interface list from /proc/net/dev
	fddev, err := open("/proc/net/dev")
	if err != nil {
		return ifat, nil
	}
	defer fddev.close()
	fddev.readLine() // skip header 1
	fddev.readLine() // skip header 2

	for l, ok := fddev.readLine(); ok; l, ok = fddev.readLine() {
		f := splitAtBytes(l, " :\r\t\n")
		if len(f) < 1 {
			continue
		}
		name := f[0]
		if ifi != nil && name != ifi.Name {
			continue
		}

		sock, serr := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0)
		if serr != nil {
			continue
		}

		ifreq := [40]byte{}
		copy(ifreq[:], name)

		// SIOCGIFADDR = 0x8915
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x8915, uintptr(unsafe.Pointer(&ifreq)))
		if errno == 0 {
			// IPv4 address at offset 20 (sin_addr in struct sockaddr_in)
			ip := IPv4(ifreq[20], ifreq[21], ifreq[22], ifreq[23])

			// SIOCGIFNETMASK = 0x891b
			copy(ifreq[:], name)
			for i := len(name); i < 16; i++ {
				ifreq[i] = 0
			}
			mask := IPMask(make([]byte, IPv4len))
			_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, uintptr(sock), 0x891b, uintptr(unsafe.Pointer(&ifreq)))
			if errno == 0 {
				mask[0] = ifreq[20]
				mask[1] = ifreq[21]
				mask[2] = ifreq[22]
				mask[3] = ifreq[23]
			} else {
				mask = CIDRMask(24, 32)
			}
			ifat = append(ifat, &IPNet{IP: ip, Mask: mask})
		}
		syscall.Close(sock)
	}
	return ifat, nil
}

func addrTable(ifi *Interface, msgs []syscall.NetlinkMessage) ([]Addr, error) {
	var ifat []Addr
loop:
	for _, m := range msgs {
		switch m.Header.Type {
		case syscall.NLMSG_DONE:
			break loop
		case syscall.RTM_NEWADDR:
			ifam := (*syscall.IfAddrmsg)(unsafe.Pointer(&m.Data[0]))
			if ifi == nil || ifi.Index == int(ifam.Index) {
				attrs, err := syscall.ParseNetlinkRouteAttr(&m)
				if err != nil {
					return nil, os.NewSyscallError("parsenetlinkrouteattr", err)
				}
				ifa := newAddr(ifam, attrs)
				if ifa != nil {
					ifat = append(ifat, ifa)
				}
			}
		}
	}
	return ifat, nil
}

func newAddr(ifam *syscall.IfAddrmsg, attrs []syscall.NetlinkRouteAttr) Addr {
	var ipPointToPoint bool
	// Seems like we need to make sure whether the IP interface
	// stack consists of IP point-to-point numbered or unnumbered
	// addressing.
	for _, a := range attrs {
		if a.Attr.Type == syscall.IFA_LOCAL {
			ipPointToPoint = true
			break
		}
	}
	for _, a := range attrs {
		if ipPointToPoint && a.Attr.Type == syscall.IFA_ADDRESS {
			continue
		}
		switch ifam.Family {
		case syscall.AF_INET:
			return &IPNet{IP: IPv4(a.Value[0], a.Value[1], a.Value[2], a.Value[3]), Mask: CIDRMask(int(ifam.Prefixlen), 8*IPv4len)}
		case syscall.AF_INET6:
			ifa := &IPNet{IP: make(IP, IPv6len), Mask: CIDRMask(int(ifam.Prefixlen), 8*IPv6len)}
			copy(ifa.IP, a.Value[:])
			return ifa
		}
	}
	return nil
}

// interfaceMulticastAddrTable returns addresses for a specific
// interface.
func interfaceMulticastAddrTable(ifi *Interface) ([]Addr, error) {
	ifmat4 := parseProcNetIGMP("/proc/net/igmp", ifi)
	ifmat6 := parseProcNetIGMP6("/proc/net/igmp6", ifi)
	return append(ifmat4, ifmat6...), nil
}

func parseProcNetIGMP(path string, ifi *Interface) []Addr {
	fd, err := open(path)
	if err != nil {
		return nil
	}
	defer fd.close()
	var (
		ifmat []Addr
		name  string
	)
	fd.readLine() // skip first line
	b := make([]byte, IPv4len)
	for l, ok := fd.readLine(); ok; l, ok = fd.readLine() {
		f := splitAtBytes(l, " :\r\t\n")
		if len(f) < 4 {
			continue
		}
		switch {
		case l[0] != ' ' && l[0] != '\t': // new interface line
			name = f[1]
		case len(f[0]) == 8:
			if ifi == nil || name == ifi.Name {
				// The Linux kernel puts the IP
				// address in /proc/net/igmp in native
				// endianness.
				for i := 0; i+1 < len(f[0]); i += 2 {
					b[i/2], _ = xtoi2(f[0][i:i+2], 0)
				}
				i := *(*uint32)(unsafe.Pointer(&b[:4][0]))
				ifma := &IPAddr{IP: IPv4(byte(i>>24), byte(i>>16), byte(i>>8), byte(i))}
				ifmat = append(ifmat, ifma)
			}
		}
	}
	return ifmat
}

func parseProcNetIGMP6(path string, ifi *Interface) []Addr {
	fd, err := open(path)
	if err != nil {
		return nil
	}
	defer fd.close()
	var ifmat []Addr
	b := make([]byte, IPv6len)
	for l, ok := fd.readLine(); ok; l, ok = fd.readLine() {
		f := splitAtBytes(l, " \r\t\n")
		if len(f) < 6 {
			continue
		}
		if ifi == nil || f[1] == ifi.Name {
			for i := 0; i+1 < len(f[2]); i += 2 {
				b[i/2], _ = xtoi2(f[2][i:i+2], 0)
			}
			ifma := &IPAddr{IP: IP{b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]}}
			ifmat = append(ifmat, ifma)
		}
	}
	return ifmat
}
