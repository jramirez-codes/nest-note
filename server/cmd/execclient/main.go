// Command execclient stands in for the phone's /run <cmd> channel: it pins the
// server's SPKI exactly as the app will, optionally pairs, then opens /exec and
// streams a shell command's stdout/stderr live. It forwards your keystrokes to
// the process as stdin and turns a local Ctrl-C into a SIGINT frame, so you can
// prove interactive commands and long-running dev servers over the tunnel before
// any app code exists.
//
// Examples:
//
//	go run ./cmd/execclient --pin <PIN> --code <CODE> --cmd "echo hi && ls"
//	go run ./cmd/execclient --pin <PIN> --token <TOK> --cmd "npm run dev" --dir myproject
//	go run ./cmd/execclient --pin <PIN> --token <TOK> --cmd "cat"   # then type; Ctrl-C to interrupt
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
	"os/signal"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

func main() {
	var (
		url   = flag.String("url", "wss://127.0.0.1:8443/exec", "server /exec URL")
		pin   = flag.String("pin", "", "expected server SPKI pin (base64 sha256)")
		token = flag.String("token", "", "bearer token (skip if using --code)")
		code  = flag.String("code", "", "one-time pairing code, exchanged for a token")
		cmd   = flag.String("cmd", "echo hello from exec", "shell command to run")
		dir   = flag.String("dir", "", "optional project subdir (relative to the server workdir)")
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

	stream(ctx, client, *url, *token, *cmd, *dir)
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
// bearer token. The exec URL is reused, rewritten to https:///pair.
func pair(ctx context.Context, client *http.Client, execURL, code string) (string, error) {
	u, err := neturl.Parse(execURL)
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

// stream dials /exec, sends the command, then prints output frames live while
// forwarding local stdin and Ctrl-C to the server.
func stream(ctx context.Context, client *http.Client, url, token, cmd, dir string) {
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	req, _ := json.Marshal(map[string]string{"cmd": cmd, "dir": dir})
	if err := c.Write(ctx, websocket.MessageText, req); err != nil {
		log.Fatalf("write: %v", err)
	}
	fmt.Printf("[exec] %s\n", cmd)

	// Local Ctrl-C → a SIGINT frame (interrupt the remote process), not our exit.
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, os.Interrupt, syscall.SIGINT)
	go func() {
		for range sigc {
			fmt.Println("\n[^C → SIGINT]")
			frame, _ := json.Marshal(map[string]string{"type": "signal", "sig": "SIGINT"})
			_ = c.Write(ctx, websocket.MessageText, frame)
		}
	}()

	// Forward local stdin to the remote process (so interactive commands work).
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				frame, _ := json.Marshal(map[string]string{"type": "stdin", "data": string(buf[:n])})
				if werr := c.Write(ctx, websocket.MessageText, frame); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
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
	fmt.Printf("\n[stream closed at %s]\n", time.Now().Format(time.Kitchen))
}

// printFrame renders one server frame: log chunks go to the matching stream,
// exit prints the code, error prints the message.
func printFrame(data []byte) {
	var f struct {
		Type    string `json:"type"`
		Stream  string `json:"stream"`
		Data    string `json:"data"`
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		fmt.Printf("[raw] %s\n", data)
		return
	}
	switch f.Type {
	case "log":
		w := os.Stdout
		if f.Stream == "stderr" {
			w = os.Stderr
		}
		fmt.Fprint(w, f.Data)
	case "exit":
		fmt.Printf("\n[exit %d]\n", f.Code)
	case "error":
		fmt.Printf("\n[error] %s\n", f.Message)
	default:
		fmt.Printf("[%s]\n", f.Type)
	}
}
