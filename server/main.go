// Command server is the NestNote companion server. This file does three things
// and nothing else: parse the flags, assemble the dependencies, and start the
// TLS listener. The HTTP surface itself lives in routes.go, and each endpoint's
// behaviour under internal/<feature>/.
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

	"nestnote/server/internal/build"
	"nestnote/server/internal/cron"
	"nestnote/server/internal/pairing"
	"nestnote/server/internal/scaffold"
	"nestnote/server/internal/session"
	"nestnote/server/internal/view"
)

func main() {
	var (
		port       = flag.Int("port", 8443, "TLS port to listen on")
		addr       = flag.String("addr", "", "bind address (default: auto-detected LAN IP)")
		advHost    = flag.String("advertise-host", "", "host to put in the pairing QR (e.g. a Tailscale IP or DDNS name for off-LAN access); default: bind address")
		dir        = flag.String("dir", defaultStateDir(), "directory for cert/key/token")
		workdir    = flag.String("workdir", mustCwd(), "directory Claude runs in (ignored when -root is set)")
		repoDir    = flag.String("repo-dir", "", "path to the nest-note git checkout that /update server fetches & rebuilds; empty = <root>/nest-note, falling back to the pre-rebrand <root>/ai-notepad if that's what exists")
		root       = flag.String("root", "", "scaffold projects/, mcp/, orchestrator/ under this dir and enable MCP; Claude runs in <root>/projects. Empty = disabled")
		threshold  = flag.Int("subject-threshold", 4, "mentions before the orchestrator proposes a dedicated server for a subject (with -root)")
		runTimeout = flag.Duration("run-timeout", 8*time.Minute, "max time for a single Claude run before it is killed and reported as failed (/agg-tasks sweeps a whole notebook and can need several minutes)")
		pairTTL    = flag.Duration("pair-ttl", 10*time.Minute, "how long the pairing code stays valid")
		allowExec  = flag.Bool("allow-exec", false, "enable /exec: the direct \"/run <cmd>\" shell channel. OFF by default — it runs arbitrary commands as this user, gated only by the pinned tunnel + token")
		allowCode  = flag.Bool("allow-code", false, "enable /code: a persistent Claude Code agent session in projects/<name> with every tool auto-accepted (bypassPermissions). OFF by default — full code execution as this user, gated only by the pinned tunnel + token")
		allowView  = flag.Bool("allow-view", false, "enable /view: on-demand plaintext LAN reverse-proxies that mirror your localhost dev servers to the phone's note editor. OFF by default — serves each previewed dev server over cleartext HTTP to anyone on the LAN")
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
	var boot scaffold.Setup
	if *root != "" {
		setup, err := scaffold.Root(*root, *threshold)
		if err != nil {
			// Don't die here. This scaffold is a warm-up — every /run re-scaffolds,
			// so a failure now is reported again (with the same error) at the next
			// message, and staying up keeps /update server reachable. Exiting instead
			// would strand a remote machine: the process that just restarted into a
			// bad build is the only way anyone could push the fix.
			log.Printf("root scaffold failed, continuing without MCP (retried on the next /run): %v", err)
		} else {
			boot = setup
			runDir = setup.ProjectsDir
		}
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

	// Computed before the routes because the build tick's generated driver script
	// bakes this address in — cron curls back to exactly the listener we start.
	listenAddr := net.JoinHostPort(bindIP, fmt.Sprintf("%d", *port))

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

	cert, err := pairing.LoadOrCreateCert(*dir, sans)
	if err != nil {
		log.Fatalf("cert: %v", err)
	}
	leaf, err := pairing.CertLeaf(cert)
	if err != nil {
		log.Fatalf("cert parse: %v", err)
	}

	token, err := pairing.LoadOrCreateToken(*dir)
	if err != nil {
		log.Fatalf("token: %v", err)
	}

	pin := pairing.SPKIPin(leaf)
	pr, err := pairing.New(token, *pairTTL)
	if err != nil {
		log.Fatalf("pairing: %v", err)
	}

	// Durable-session registry shared by the three streaming endpoints (/run,
	// /exec, /code): it keeps a run's process alive and buffering when the socket
	// drops, so the phone can background/reconnect without killing the work.
	sessions := session.NewRegistry()

	// The projects dir /code, /projects and builds all work under.
	codeBase := filepath.Join(*workdir, "projects")
	if *root != "" {
		codeBase = runDir // already <root>/projects
	}

	builds := build.Config{
		ProjectsBase: codeBase,
		Root:         *root,
		StateDir:     *dir,
		ListenAddr:   listenAddr,
		RunTimeout:   *runTimeout,
		Enabled:      *allowCode && *allowExec,
		Reg:          sessions,
		Cron:         cron.RealIO(),
	}

	mux := newMux(deps{
		token:      token,
		root:       *root,
		workdir:    *workdir,
		codeBase:   codeBase,
		runDir:     runDir,
		repoDir:    *repoDir,
		threshold:  *threshold,
		runTimeout: *runTimeout,
		allowExec:  *allowExec,
		allowCode:  *allowCode,
		allowView:  *allowView,
		boot:       boot,
		sessions:   sessions,
		builds:     builds,
		pair:       pr,
		views:      view.NewManager(bindIP),
	})

	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
	}

	// Advertise on the LAN so the phone can re-find us after an IP change.
	mdns, err := pairing.Advertise("NestNote", *port, pin)
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
		Code: pr.Code(),
	})

	fmt.Println("NestNote server")
	fmt.Printf("  listening  wss://%s/run\n", listenAddr)
	if *advHost != "" {
		fmt.Printf("  pair host  wss://%s/run  (encoded in the QR)\n", net.JoinHostPort(qrHost, fmt.Sprintf("%d", *port)))
	}
	fmt.Printf("  discovery  _nestnote._tcp on the LAN\n")
	fmt.Printf("  workdir    %s\n", runDir)
	if *root != "" {
		fmt.Printf("  mcp servers %v (+ orchestrator, auto-grows at %d mentions)\n", boot.Servers, *threshold)
		fmt.Printf("  mcp config %v\n", boot.MCPConfigs)
	}
	if *allowExec {
		fmt.Printf("  exec       ENABLED at wss://%s/exec  (/run <cmd> runs arbitrary shell as this user)\n", listenAddr)
	}
	if *allowCode {
		fmt.Printf("  code       ENABLED at wss://%s/code  (/code <name> runs a Claude agent in projects/<name>, tools auto-accepted)\n", listenAddr)
	}
	if *allowCode && *allowExec && *root != "" {
		fmt.Printf("  builds     ENABLED  (an idea can start a scheduled project build: cron pokes /build/tick every %d min, one feature per validation)\n", cron.TickMinutes)
	}
	if *allowView {
		fmt.Printf("  view       ENABLED  (/view PORT opens an on-demand PLAINTEXT LAN preview of localhost:PORT — reachable by anyone on the LAN)\n")
	}
	fmt.Printf("  spki pin   %s\n", pin)
	fmt.Printf("  pair code  %s  (valid %s, single use)\n", pr.Code(), *pairTTL)
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

// defaultStateDir is where the TLS cert/key and auth token live. Pre-rebrand
// deployments keep theirs in ~/.ainotepad-server, and we must keep using that
// directory when it's the one on disk: starting fresh would regenerate the cert
// and token, which breaks the phone's pinned certificate AND its saved token at
// once. Re-pairing needs someone at the machine to scan a QR, so on a server
// nobody can log into that mistake is unrecoverable.
func defaultStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".nestnote-server"
	}
	dir := filepath.Join(home, ".nestnote-server")
	if !isDir(dir) {
		if legacy := filepath.Join(home, ".ainotepad-server"); isDir(legacy) {
			return legacy
		}
	}
	return dir
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func mustCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatalf("cwd: %v", err)
	}
	return cwd
}
