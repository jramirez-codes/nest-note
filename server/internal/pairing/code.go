// Package pairing covers how a phone finds this server and comes to trust it:
// the self-signed TLS certificate and its SPKI pin, the mDNS advertisement that
// survives an IP change, the one-time code scanned from the QR, and the
// long-lived bearer token that code is traded for.
package pairing

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
type Pairing struct {
	mu      sync.Mutex
	code    string
	token   string
	expires time.Time
	used    bool
}

func New(token string, ttl time.Duration) (*Pairing, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	return &Pairing{
		code:    base64.RawURLEncoding.EncodeToString(raw),
		token:   token,
		expires: time.Now().Add(ttl),
	}, nil
}

// Code is the one-time pairing code, for printing into the QR at startup.
func (p *Pairing) Code() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code
}

// Redeem trades a valid, unused, unexpired code for the token, consuming it so
// it can never be replayed.
func (p *Pairing) Redeem(code string) (string, bool) {
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
func Handler(p *Pairing) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		token, ok := p.Redeem(r.URL.Query().Get("code"))
		if !ok {
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": token})
	}
}
