package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/mdp/qrterminal/v3"
)

func main() {
	var (
		port    = flag.Int("port", 8443, "TLS port to listen on")
		addr    = flag.String("addr", "", "bind address (default: auto-detected LAN IP)")
		dir     = flag.String("dir", defaultStateDir(), "directory for cert/key/token")
		workdir = flag.String("workdir", mustCwd(), "directory Claude runs in")
		pairTTL = flag.Duration("pair-ttl", 10*time.Minute, "how long the pairing code stays valid")
	)
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o700); err != nil {
		log.Fatalf("state dir: %v", err)
	}

	bindIP := *addr
	if bindIP == "" {
		bindIP = lanIP()
	}

	cert, err := loadOrCreateCert(*dir, []string{bindIP, "127.0.0.1", "localhost"})
	if err != nil {
		log.Fatalf("cert: %v", err)
	}
	leaf, err := certLeaf(cert)
	if err != nil {
		log.Fatalf("cert parse: %v", err)
	}

	token, err := loadOrCreateToken(*dir)
	if err != nil {
		log.Fatalf("token: %v", err)
	}

	pin := spkiPin(leaf)
	pr, err := newPairing(token, *pairTTL)
	if err != nil {
		log.Fatalf("pairing: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/pair", pairHandler(pr))
	mux.HandleFunc("/run", runHandler(token, *workdir))

	listenAddr := net.JoinHostPort(bindIP, fmt.Sprintf("%d", *port))
	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
	}

	// Advertise on the LAN so the phone can re-find us after an IP change.
	mdns, err := advertise("ainotepad", *port, pin)
	if err != nil {
		log.Printf("mdns: advertise failed (discovery disabled): %v", err)
	} else {
		defer mdns.Shutdown()
	}

	// The QR carries everything the phone needs to pair: address, the pin to
	// trust, and the one-time code. Scanning it is the out-of-band trust
	// transfer that makes the self-signed cert safe.
	payload, _ := json.Marshal(pairPayload{
		V:    1,
		Host: bindIP,
		Port: *port,
		Pin:  pin,
		Code: pr.code,
	})

	fmt.Println("ainotepad server")
	fmt.Printf("  listening  wss://%s/run\n", listenAddr)
	fmt.Printf("  discovery  _ainotepad._tcp on the LAN\n")
	fmt.Printf("  workdir    %s\n", *workdir)
	fmt.Printf("  spki pin   %s\n", pin)
	fmt.Printf("  pair code  %s  (valid %s, single use)\n", pr.code, *pairTTL)
	fmt.Println("\n  Scan to pair:")
	qrterminal.GenerateHalfBlock(string(payload), qrterminal.L, os.Stdout)

	log.Fatal(srv.ListenAndServeTLS("", ""))
}

// pairPayload is the JSON encoded into the pairing QR.
type pairPayload struct {
	V    int    `json:"v"`
	Host string `json:"host"`
	Port int    `json:"port"`
	Pin  string `json:"pin"`
	Code string `json:"code"`
}

// lanIP returns the first non-loopback IPv4 address, so the server binds to the
// LAN interface rather than all interfaces — reachable from the phone, not the
// whole world if the host is multi-homed.
func lanIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ip4 := ipnet.IP.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return "127.0.0.1"
}

func defaultStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".ainotepad-server"
	}
	return filepath.Join(home, ".ainotepad-server")
}

func mustCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatalf("cwd: %v", err)
	}
	return cwd
}
