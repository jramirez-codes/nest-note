// Package httpx holds the tiny HTTP helpers every endpoint needs: checking the
// bearer token and writing the two response shapes the app expects. These used
// to live wherever they were first needed — authOK in auth.go, writeJSON in
// build.go, writeOK in dashboard.go — which meant a new handler had to know
// which unrelated feature file to borrow from.
package httpx

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

// AuthOK checks the bearer token in constant time. It accepts the standard
// Authorization header and falls back to a ?token= query param, because React
// Native's WebSocket cannot set request headers on all platforms.
func AuthOK(r *http.Request, want string) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.URL.Query().Get("token")
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// Guard is the preamble nearly every handler opens with: reject the request
// with 401 unless it carries the bearer token. Returns false when the caller
// should stop, so handlers read as `if !httpx.Guard(...) { return }`.
func Guard(w http.ResponseWriter, r *http.Request, token string) bool {
	if !AuthOK(r, token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// WriteJSON sends v as the JSON body of a 200.
func WriteJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// WriteOK sends the bare {"ok":true} acknowledgement used by endpoints that
// mutate state but have nothing to report back.
func WriteOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"ok\":true}\n"))
}
