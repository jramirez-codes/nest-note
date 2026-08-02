// Package view serves /viewstart, which brings up the on-machine viewer window.
package view

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"sync"

	"nestnote/server/internal/httpx"
)

// The /view feature mirrors a localhost dev server on this laptop into the phone's
// note editor as an <iframe>. The WebView can't pin the server's self-signed cert
// (only the native layer can), so the pinned TLS mux is off-limits to a plain
// iframe. Instead each previewed port gets its OWN plaintext HTTP listener on the
// LAN that reverse-proxies 1:1 to http://127.0.0.1:<port>. A dedicated origin per
// dev server is what makes the WHOLE page render: the page's own root-relative
// assets (/app.js), XHR (/api) and HMR websockets all resolve with no path
// rewriting and no cookies — a shared, path-prefixed proxy can't, because a
// cross-site iframe won't send an auth/routing cookie (SameSite blocks it).
//
// This is a deliberate downgrade from the app's pinned tunnel: the per-port
// listeners are UNAUTHENTICATED and reachable by anyone on the LAN, exactly like
// binding your dev server to 0.0.0.0. So the whole feature is OFF by default
// (-allow-view), and only an authenticated /viewstart can spin a listener up.

// viewManager lazily starts one reverse-proxy listener per target dev-server port
// and remembers the LAN port each got, so repeat /view of the same port reuses it.
type Manager struct {
	bindIP string
	mu     sync.Mutex
	byPort map[int]int // target dev port -> assigned LAN listener port
}

func NewManager(bindIP string) *Manager {
	return &Manager{bindIP: bindIP, byPort: map[int]int{}}
}

// start ensures a plaintext proxy is listening for `target` and returns the LAN
// port it's on. Idempotent: the same target always maps to the same listener.
func (m *Manager) start(target int) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.byPort[target]; ok {
		return p, nil
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(m.bindIP, "0"))
	if err != nil {
		return 0, err
	}
	listenPort := ln.Addr().(*net.TCPAddr).Port
	upstream := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(target)}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	// Strip framing guards so the page can be embedded in the note's iframe even if
	// the dev server sends X-Frame-Options / a frame-ancestors CSP.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("X-Frame-Options")
		resp.Header.Del("Content-Security-Policy")
		resp.Header.Del("Content-Security-Policy-Report-Only")
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, fmt.Sprintf("view: cannot reach localhost:%d — %v", target, err), http.StatusBadGateway)
	}
	srv := &http.Server{Handler: proxy}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("view proxy for :%d stopped: %v", target, err)
		}
	}()
	m.byPort[target] = listenPort
	return listenPort, nil
}

// StartHandler runs on the pinned mux. The phone posts here (token-authed)
// with ?port=<dev port>; it starts/reuses that port's LAN proxy and returns the
// port the phone should point its iframe at. When disabled it reports so, so the
// card can explain how to turn it on.
func StartHandler(token string, enabled bool, m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !httpx.Guard(w, r, token) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if !enabled {
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": false})
			return
		}
		target, err := strconv.Atoi(r.URL.Query().Get("port"))
		if err != nil || target <= 0 || target > 65535 {
			http.Error(w, "bad port", http.StatusBadRequest)
			return
		}
		listenPort, err := m.start(target)
		if err != nil {
			http.Error(w, "view: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "port": listenPort})
	}
}
