//go:build !windows

package main

// adapterDescriptions is Windows only; elsewhere the interface names say enough
// (docker0, virbr0, vboxnet0).
func adapterDescriptions() map[int]string { return nil }
