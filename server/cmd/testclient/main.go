// Command testclient stands in for the phone: it pins the server's SPKI exactly
// as the RN app will, optionally pairs (trading the one-time code for a token),
// then streams a prompt through Claude. It proves the whole secure channel on
// the laptop before any app code exists.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	neturl "net/url"
	"os"
	"time"

	"github.com/coder/websocket"
)

func main() {
	var (
		url    = flag.String("url", "wss://127.0.0.1:8443/run", "server /run URL")
		pin    = flag.String("pin", "", "expected server SPKI pin (base64 sha256)")
		token  = flag.String("token", "", "bearer token (skip if using --code)")
		code   = flag.String("code", "", "one-time pairing code, exchanged for a token")
		prompt = flag.String("prompt", "say hi in one word", "prompt for Claude")
	)
	flag.Parse()

	if *pin == "" {
		log.Fatal("--pin is required (from the server startup log or QR)")
	}
	if *token == "" && *code == "" {
		log.Fatal("provide --token, or --code to pair for one")
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: pinnedTLS(*pin)}}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if *token == "" {
		t, err := pair(ctx, client, *url, *code)
		if err != nil {
			log.Fatalf("pair: %v", err)
		}
		*token = t
		fmt.Printf("[paired] token acquired: %s…\n", t[:8])
	}

	stream(ctx, client, *url, *token, *prompt)
}

// pinnedTLS trusts exactly one server public key — the one from the QR — and
// ignores the system CA chain. This is what makes a self-signed cert safe
// against a LAN man-in-the-middle.
func pinnedTLS(pin string) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, // #nosec G402 — replaced by the pin check below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return fmt.Errorf("no server certificate")
			}
			sum := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if got := base64.StdEncoding.EncodeToString(sum[:]); got != pin {
				return fmt.Errorf("pin mismatch: got %s want %s", got, pin)
			}
			return nil
		},
	}
}

// pair POSTs the one-time code to /pair over the pinned tunnel and returns the
// bearer token. The run URL is reused, rewritten to https:///pair.
func pair(ctx context.Context, client *http.Client, runURL, code string) (string, error) {
	u, err := neturl.Parse(runURL)
	if err != nil {
		return "", err
	}
	u.Scheme = "https"
	u.Path = "/pair"
	u.RawQuery = "code=" + neturl.QueryEscape(code)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.Token, nil
}

// stream dials /run and prints the Claude output as it arrives.
func stream(ctx context.Context, client *http.Client, url, token, prompt string) {
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	req, _ := json.Marshal(map[string]string{"prompt": prompt})
	if err := c.Write(ctx, websocket.MessageText, req); err != nil {
		log.Fatalf("write: %v", err)
	}

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				break
			}
			log.Printf("read: %v", err)
			os.Exit(1)
		}
		printChunk(data)
	}
	fmt.Println("\n[stream closed]")
}

// printChunk surfaces the type of each stream-json line and the assistant text,
// so the streaming is visible at a glance.
func printChunk(data []byte) {
	var msg struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
		Result string `json:"result"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		fmt.Printf("[raw] %s\n", data)
		return
	}
	switch msg.Type {
	case "assistant":
		for _, b := range msg.Message.Content {
			if b.Type == "text" {
				fmt.Printf("[assistant] %s\n", b.Text)
			}
		}
	case "result":
		fmt.Printf("[result] %s\n", msg.Result)
	default:
		fmt.Printf("[%s]\n", msg.Type)
	}
}
