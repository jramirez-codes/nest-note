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
	var boot mcpSetup
	if *root != "" {
		setup, err := scaffoldRoot(*root, *threshold)
		if err != nil {
			// Don't die here. This scaffold is a warm-up — every /run re-scaffolds,
			// so a failure now is reported again (with the same error) at the next
			// message, and staying up keeps /update server reachable. Exiting instead
			// would strand a remote machine: the process that just restarted into a
			// bad build is the only way anyone could push the fix.
			log.Printf("root scaffold failed, continuing without MCP (retried on the next /run): %v", err)
		} else {
			boot = setup
			runDir = setup.projectsDir
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

	// Durable-session registry shared by the three streaming endpoints (/run,
	// /exec, /code): it keeps a run's process alive and buffering when the socket
	// drops, so the phone can background/reconnect without killing the work.
	sessions := newSessionRegistry()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/pair", pairHandler(pr))
	mux.HandleFunc("/run", runHandler(token, *workdir, *root, *threshold, *runTimeout, boot, sessions))
	// Direct shell channel for /run <cmd> — streams stdout/stderr live, no Claude.
	// Runs in the same base workdir Claude uses. Gated behind -allow-exec.
	mux.HandleFunc("/exec", execHandler(token, runDir, *allowExec, sessions))
	// Persistent Claude Code agent session for /code <name>. Each session opens
	// projects/<slug> (created if missing) under the projects dir — <root>/projects
	// when -root is set, else <workdir>/projects. Gated behind -allow-code.
	codeBase := filepath.Join(*workdir, "projects")
	if *root != "" {
		codeBase = runDir // already <root>/projects
	}
	mux.HandleFunc("/code", agentHandler(token, codeBase, *allowCode, sessions))
	// Read-only listing of projects/<name> dirs so the phone can autocomplete
	// `/code <name>`. Same base and enable flag as /code; empty list when off.
	mux.HandleFunc("/projects", projectsHandler(token, codeBase, *allowCode))
	// Destructive counterpart to /projects: POST a project name to remove its
	// folder. Same base and enable flag; the phone confirms before calling it.
	// It also drops any scheduled build's crontab line for that project.
	cron := realCrontabIO()
	mux.HandleFunc("/projects/delete", deleteProjectHandler(token, codeBase, *allowCode, cron))
	// Scheduled idea builds: /build/start turns an idea card into a project folder
	// with a plan and a crontab entry, /build/tick is what that entry pokes, and
	// each feature pauses on a dashboard card until the user validates it. Gated on
	// -allow-code AND -allow-exec together — a build step is exactly those two
	// capabilities run unattended, so it needs no flag of its own — plus -root,
	// since the gate cards live in the scaffold. See server/build.go.
	builds := buildConfig{
		projectsBase: codeBase,
		root:         *root,
		stateDir:     *dir,
		listenAddr:   listenAddr,
		runTimeout:   *runTimeout,
		enabled:      *allowCode && *allowExec,
		reg:          sessions,
		cron:         cron,
	}
	mux.HandleFunc("/build", buildStateHandler(token, builds))
	mux.HandleFunc("/build/start", buildStartHandler(token, builds))
	// Moving the start time of a build that hasn't begun — only legal while it
	// waits, since after that a plan exists and there is nothing left to defer.
	mux.HandleFunc("/build/schedule", buildScheduleHandler(token, builds))
	mux.HandleFunc("/build/stop", buildStopHandler(token, builds))
	mux.HandleFunc("/build/tick", buildTickHandler(token, builds))
	// Read-only dashboard state + the optional merge-approval action. Both only
	// touch the scaffold's data files, so they need no Claude run.
	// On-demand page-preview proxies for /view: an authed /viewstart spins up (or
	// reuses) a dedicated plaintext LAN listener per dev-server port and tells the
	// phone which port to point its iframe at. See server/view.go.
	viewMgr := newViewManager(bindIP)
	mux.HandleFunc("/viewstart", viewStartHandler(token, *allowView, viewMgr))
	// Self-update: check out a branch (main by default), rebuild this binary, and
	// restart into it. Driven by a note's `/update server [branch]`. Always enabled
	// — it runs one fixed recipe (never caller-supplied commands, only a validated
	// branch name), gated by the pinned tunnel + token like everything else. See
	// server/update.go.
	mux.HandleFunc("/update", updateHandler(token, *root, *repoDir))
	mux.HandleFunc("/state", stateHandler(token, *root))
	mux.HandleFunc("/notebook", notebookHandler(token, *root))
	mux.HandleFunc("/page", pageHandler(token, *root))
	mux.HandleFunc("/action", actionHandler(token, *root))
	// Read-only full-text search across every notebook's pages, backing the
	// editor's `/search <query>` autocomplete. See server/search.go.
	mux.HandleFunc("/search", searchHandler(token, *root))

	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
	}

	// Advertise on the LAN so the phone can re-find us after an IP change.
	mdns, err := advertise("NestNote", *port, pin)
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

	fmt.Println("NestNote server")
	fmt.Printf("  listening  wss://%s/run\n", listenAddr)
	if *advHost != "" {
		fmt.Printf("  pair host  wss://%s/run  (encoded in the QR)\n", net.JoinHostPort(qrHost, fmt.Sprintf("%d", *port)))
	}
	fmt.Printf("  discovery  _nestnote._tcp on the LAN\n")
	fmt.Printf("  workdir    %s\n", runDir)
	if *root != "" {
		fmt.Printf("  mcp servers %v (+ orchestrator, auto-grows at %d mentions)\n", boot.servers, *threshold)
		fmt.Printf("  mcp config %v\n", boot.mcpConfigs)
	}
	if *allowExec {
		fmt.Printf("  exec       ENABLED at wss://%s/exec  (/run <cmd> runs arbitrary shell as this user)\n", listenAddr)
	}
	if *allowCode {
		fmt.Printf("  code       ENABLED at wss://%s/code  (/code <name> runs a Claude agent in projects/<name>, tools auto-accepted)\n", listenAddr)
	}
	if *allowCode && *allowExec && *root != "" {
		fmt.Printf("  builds     ENABLED  (an idea can start a scheduled project build: cron pokes /build/tick every %d min, one feature per validation)\n", buildTickMinutes)
	}
	if *allowView {
		fmt.Printf("  view       ENABLED  (/view PORT opens an on-demand PLAINTEXT LAN preview of localhost:PORT — reachable by anyone on the LAN)\n")
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

func mustCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatalf("cwd: %v", err)
	}
	return cwd
}
