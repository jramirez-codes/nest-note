// Command agentclient stands in for the phone's /code <name> channel: it pins
// the server's SPKI exactly as the app will, optionally pairs, then opens /code
// and drives a persistent Claude Code agent session in projects/<name>. It
// prints the assistant's text, its tool calls and results as they stream, and
// forwards each line you type as a follow-up prompt — so you can prove multi-turn
// agent sessions and real tool execution over the tunnel before any app code
// exists. A local Ctrl-C sends kill and ends the session.
//
// Examples:
//
//	go run ./cmd/agentclient --pin <PIN> --code <CODE> --project scratch --prompt "what files are here?"
//	go run ./cmd/agentclient --pin <PIN> --token <TOK> --project scratch
//	  # then type follow-up prompts, one per line; Ctrl-C to end the session
package main

import (
	"bufio"
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
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

func main() {
	var (
		url     = flag.String("url", "wss://127.0.0.1:8443/code", "server /code URL")
		pin     = flag.String("pin", "", "expected server SPKI pin (base64 sha256)")
		token   = flag.String("token", "", "bearer token (skip if using --code)")
		code    = flag.String("code", "", "one-time pairing code, exchanged for a token")
		project = flag.String("project", "scratch", "project name (opens projects/<slug>, created if missing)")
		prompt  = flag.String("prompt", "", "optional first prompt to send on connect")
	)
	flag.Parse()

	if *pin == "" {
		log.Fatal("--pin is required (from the server startup log or QR)")
	}
	if *token == "" && *code == "" {
		log.Fatal("provide --token, or --code to pair for one")
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: pinnedTLS(*pin)}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if *token == "" {
		t, err := pair(ctx, client, *url, *code)
		if err != nil {
			log.Fatalf("pair: %v", err)
		}
		*token = t
		fmt.Printf("[paired] token acquired: %s…\n", t[:8])
	}

	session(ctx, client, *url, *token, *project, *prompt)
}

// pinnedTLS trusts exactly one server public key — the one from the QR — and
// ignores the system CA chain, defeating a LAN man-in-the-middle.
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

// pair POSTs the one-time code to /pair over the pinned tunnel, returning the
// bearer token. The code URL is reused, rewritten to https:///pair.
func pair(ctx context.Context, client *http.Client, codeURL, code string) (string, error) {
	u, err := neturl.Parse(codeURL)
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

// session dials /code, opens the project, then prints agent output live while
// forwarding each typed line as a follow-up prompt and Ctrl-C as kill.
func session(ctx context.Context, client *http.Client, url, token, project, prompt string) {
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	req, _ := json.Marshal(map[string]string{"project": project, "prompt": prompt})
	if err := c.Write(ctx, websocket.MessageText, req); err != nil {
		log.Fatalf("write: %v", err)
	}
	fmt.Printf("[code] project=%s%s\n", project, iff(prompt != "", "  prompt="+prompt, ""))

	// Local Ctrl-C → kill the remote session (not just our process).
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, os.Interrupt, syscall.SIGINT)
	go func() {
		for range sigc {
			fmt.Println("\n[^C → kill session]")
			frame, _ := json.Marshal(map[string]string{"type": "kill"})
			_ = c.Write(ctx, websocket.MessageText, frame)
		}
	}()

	// Each typed line becomes a follow-up prompt for the running session.
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			frame, _ := json.Marshal(map[string]string{"type": "prompt", "text": line})
			if werr := c.Write(ctx, websocket.MessageText, frame); werr != nil {
				return
			}
			fmt.Printf("[→ prompt] %s\n", line)
		}
	}()

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				break
			}
			log.Printf("read: %v", err)
			os.Exit(1)
		}
		printFrame(data)
	}
	fmt.Printf("\n[session closed at %s]\n", time.Now().Format(time.Kitchen))
}

// printFrame renders one server frame. "cc" wraps a raw Claude stream-json object
// under "msg" — we pull out the human-interesting parts (assistant text, tool
// calls, tool results, the final result); everything else prints as a terse tag.
func printFrame(data []byte) {
	var f struct {
		Type    string          `json:"type"`
		Msg     json.RawMessage `json:"msg"`
		Message string          `json:"message"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		fmt.Printf("[raw] %s\n", data)
		return
	}
	switch f.Type {
	case "cc":
		printCC(f.Msg)
	case "exit":
		fmt.Printf("\n[session ended]\n")
	case "error":
		fmt.Printf("\n[error] %s\n", f.Message)
	default:
		fmt.Printf("[%s]\n", f.Type)
	}
}

func printCC(raw json.RawMessage) {
	var m struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Message struct {
			Content []struct {
				Type    string          `json:"type"`
				Text    string          `json:"text"`
				Name    string          `json:"name"`
				Input   json.RawMessage `json:"input"`
				Content json.RawMessage `json:"content"`
				IsError bool            `json:"is_error"`
			} `json:"content"`
		} `json:"message"`
		Result string `json:"result"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	switch m.Type {
	case "system":
		if m.Subtype == "init" {
			fmt.Printf("[session ready]\n")
		}
	case "assistant":
		for _, b := range m.Message.Content {
			switch b.Type {
			case "text":
				if strings.TrimSpace(b.Text) != "" {
					fmt.Printf("\n\033[36m%s\033[0m\n", b.Text)
				}
			case "tool_use":
				fmt.Printf("  \033[33m⚙ %s\033[0m %s\n", b.Name, truncate(string(b.Input), 120))
			}
		}
	case "user":
		for _, b := range m.Message.Content {
			if b.Type == "tool_result" {
				tag := "tool_result"
				if b.IsError {
					tag = "tool_result ERROR"
				}
				fmt.Printf("  \033[90m← %s: %s\033[0m\n", tag, truncate(string(b.Content), 120))
			}
		}
	case "result":
		fmt.Printf("\033[32m[turn done]\033[0m %s\n", truncate(m.Result, 200))
	}
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func iff(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}
