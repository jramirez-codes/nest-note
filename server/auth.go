package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// loadOrCreateToken returns a persistent bearer token. In step 1 it stands in
// for the full pairing flow: the phone will later obtain this by trading a
// one-time pairing code. The token only ever travels inside the pinned TLS
// tunnel, so it can't be sniffed on the LAN — but it is a shell key, so it's
// stored 0600 and printed only to the operator's terminal.
func loadOrCreateToken(dir string) (string, error) {
	path := filepath.Join(dir, "token")
	if b, err := os.ReadFile(path); err == nil {
		return strings.TrimSpace(string(b)), nil
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(tok), 0o600); err != nil {
		return "", err
	}
	return tok, nil
}

// authOK checks the bearer token in constant time. It accepts the standard
// Authorization header and falls back to a ?token= query param, because React
// Native's WebSocket cannot set request headers on all platforms.
func authOK(r *http.Request, want string) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.URL.Query().Get("token")
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}
