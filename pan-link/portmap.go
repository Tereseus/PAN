package link

import (
	"context"
	"net/netip"

	"tailscale.com/net/netmon"
	"tailscale.com/net/portmapper"
	"tailscale.com/net/portmapper/portmappertype"
	"tailscale.com/util/eventbus"
)

// PortMapper asks the home router to forward the hub's UDP port (UPnP, NAT-PMP or PCP),
// using Tailscale's portmapper (BSD-3, the same code every Tailscale client runs).
//
// Opening a router port changes the person's network, so the hub only does it when PAN
// Setup asks (the person agreed during setup). Tests never call it against a router.
type PortMapper struct {
	bus *eventbus.Bus
	mon *netmon.Monitor
	c   *portmapper.Client
}

// NewPortMapper prepares a mapper for the hub's local UDP port. It does not contact the
// router until Probe or External is called. onChange (may be nil) runs in its own
// goroutine whenever the mapping appears, changes or goes away.
func NewPortMapper(localPort uint16, logf func(string, ...any), onChange func()) (*PortMapper, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	bus := eventbus.New()
	mon, err := netmon.New(bus, logf)
	if err != nil {
		bus.Close()
		return nil, err
	}
	c := portmapper.NewClient(portmapper.Config{EventBus: bus, Logf: logf, NetMon: mon, OnChange: onChange})
	c.SetLocalPort(localPort)
	return &PortMapper{bus: bus, mon: mon, c: c}, nil
}

// Probe asks which mapping protocols the router answers. It opens nothing.
func (p *PortMapper) Probe(ctx context.Context) (portmappertype.ProbeResult, error) {
	return p.c.Probe(ctx)
}

// External returns the public address once the router has mapped the port. The first
// call starts the mapping in the background and usually returns ok=false; call again
// a few seconds later. Renewal also happens inside this call (once the mapping is past
// its renew time), so the hub calls it on a timer, not only when making a pairing code.
func (p *PortMapper) External() (netip.AddrPort, bool) {
	return p.c.GetCachedMappingOrStartCreatingOne()
}

// Close asks the router to drop the mapping (UPnP delete, or a zero lifetime for
// NAT-PMP and PCP) and stops renewing it.
func (p *PortMapper) Close() {
	p.c.Close()
	p.mon.Close()
	p.bus.Close()
}
