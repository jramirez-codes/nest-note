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
		advHost = flag.String("advertise-host", "", "host to put in the pairing QR (e.g. a Tailscale IP or DDNS name for off-LAN access); default: bind address")
		dir     = flag.String("dir", defaultStateDir(), "directory for cert/key/token")
		workdir = flag.String("workdir", mustCwd(), "directory Claude runs in (ignored when -root is set)")
		root      = flag.String("root", "", "scaffold projects/, mcp/, orchestrator/ under this dir and enable MCP; Claude runs in <root>/projects. Empty = disabled")
		threshold  = flag.Int("subject-threshold", 4, "mentions before the orchestrator proposes a dedicated server for a subject (with -root)")
		runTimeout = flag.Duration("run-timeout", 2*time.Minute, "max time for a single Claude run before it is killed and reported as failed")
		pairTTL    = flag.Duration("pair-ttl", 10*time.Minute, "how long the pairing code stays valid")
	)
	flag.Parse()

	if err := os.MkdirAll(*dir, 0o700); err != nil {
		log.Fatalf("state dir: %v", err)
	}

	// When -root is set, scaffold the projects/mcp/orchestrator layout, build
	// the MCP servers, and point Claude at <root>/projects. This boot scaffold
	// is for the startup banner and as a fallback; each /run re-scaffolds so
	// servers the orchestrator creates mid-session go live on the next message.
	runDir := *workdir
	var boot mcpSetup
	if *root != "" {
		setup, err := scaffoldRoot(*root, *threshold)
		if err != nil {
			log.Fatalf("root scaffold: %v", err)
		}
		boot = setup
		runDir = setup.projectsDir
	}

	bindIP := *addr
	if bindIP == "" {
		// Reaching us off-LAN (e.g. over Tailscale) means listening on that
		// interface, not only the LAN one — so when an advertise host is given,
		// default to all interfaces rather than the single LAN IP.
		if *advHost != "" {
			bindIP = "0.0.0.0"
		} else {
			bindIP = lanIP()
		}
	}

	// Addresses the cert is valid for. The client pins the SPKI and skips
	// hostname checks, so which one the phone uses doesn't affect trust — but
	// listing the real ones keeps any stricter client working, including over a
	// Tailscale IP or DDNS name passed via -advertise-host.
	sans := []string{"127.0.0.1", "localhost"}
	for _, h := range []string{bindIP, lanIP(), *advHost} {
		if h != "" && h != "0.0.0.0" {
			sans = append(sans, h)
		}
	}

	cert, err := loadOrCreateCert(*dir, sans)
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
	mux.HandleFunc("/run", runHandler(token, *workdir, *root, *threshold, *runTimeout, boot))

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
	// transfer that makes the self-signed cert safe. The host the phone stores
	// is the advertise host when set (a Tailscale IP or DDNS name it can reach
	// off-LAN), else the bind IP for plain same-LAN use.
	qrHost := *advHost
	if qrHost == "" {
		qrHost = bindIP
	}
	payload, _ := json.Marshal(pairPayload{
		V:    1,
		Host: qrHost,
		Port: *port,
		Pin:  pin,
		Code: pr.code,
	})

	fmt.Println("ainotepad server")
	fmt.Printf("  listening  wss://%s/run\n", listenAddr)
	if *advHost != "" {
		fmt.Printf("  pair host  wss://%s/run  (encoded in the QR)\n", net.JoinHostPort(qrHost, fmt.Sprintf("%d", *port)))
	}
	fmt.Printf("  discovery  _ainotepad._tcp on the LAN\n")
	fmt.Printf("  workdir    %s\n", runDir)
	if *root != "" {
		fmt.Printf("  mcp servers %v (+ orchestrator, auto-grows at %d mentions)\n", boot.servers, *threshold)
		fmt.Printf("  mcp config %v\n", boot.mcpConfigs)
	}
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
