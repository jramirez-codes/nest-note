package pairing

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

// LoadOrCreateToken returns a persistent bearer token. It is the credential the
// phone receives at the end of the pairing flow, by trading a one-time pairing
// code. The token only ever travels inside the pinned TLS tunnel, so it can't be
// sniffed on the LAN — but it is a shell key, so it's stored 0600 and printed
// only to the operator's terminal.
func LoadOrCreateToken(dir string) (string, error) {
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
