package main

import "github.com/grandcat/zeroconf"

// advertise publishes the server on the LAN as _ainotepad._tcp so the phone can
// re-find it after the laptop's IP changes, without hand-typing an address.
// Discovery grants no trust on its own: the TXT record carries the SPKI pin only
// as a convenience, and the phone still trusts the pin it captured from the QR
// at pairing — never a pin learned from mDNS.
func advertise(instance string, port int, pin string) (*zeroconf.Server, error) {
	return zeroconf.Register(
		instance,
		"_ainotepad._tcp",
		"local.",
		port,
		[]string{"v=1", "pin=" + pin},
		nil, // advertise on all interfaces
	)
}
