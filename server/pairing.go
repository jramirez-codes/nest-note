package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// pairing holds a single one-time code that a freshly-scanned phone redeems for
// the long-lived bearer token. The code is transferred out-of-band (QR → your
// eyes), so no one on the LAN sees it; redeeming it happens inside the pinned
// TLS tunnel, so the token it returns can't be sniffed either. Single-use +
// short TTL keep the exposure window tiny.
type pairing struct {
	mu      sync.Mutex
	code    string
	token   string
	expires time.Time
	used    bool
}

func newPairing(token string, ttl time.Duration) (*pairing, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	return &pairing{
		code:    base64.RawURLEncoding.EncodeToString(raw),
		token:   token,
		expires: time.Now().Add(ttl),
	}, nil
}

// redeem trades a valid, unused, unexpired code for the token, consuming it so
// it can never be replayed.
func (p *pairing) redeem(code string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.used || time.Now().After(p.expires) {
		return "", false
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(p.code)) != 1 {
		return "", false
	}
	p.used = true
	return p.token, true
}

// pairHandler serves POST /pair?code=… and returns {"token": …} on success.
// It needs no bearer token — it is the endpoint that issues one — but it is
// still reachable only over the pinned TLS connection the phone established from
// the QR, and only with the matching one-time code.
func pairHandler(p *pairing) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		token, ok := p.redeem(r.URL.Query().Get("code"))
		if !ok {
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
	}
}
