package forkagent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestMain(m *testing.M) {
	// Detached connector children run this same test executable. Intercept its
	// CLI entry before testing's flag parser; no production binary/build is needed.
	if os.Getenv("FORK_AGENT_TEST_HELPER") == "1" && len(os.Args) > 1 && os.Args[1] == "--config" {
		if err := CLI(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr, "test"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestBackgroundStartStopAndRestart(t *testing.T) {
	helper := helperExecutable(t)
	dir := t.TempDir()
	host, port := testGateway(t, func(command string, ch ssh.Channel) {
		if command == "agent" {
			_ = json.NewEncoder(ch).Encode(record{Type: "ready", Protocol: "fork-agent/1", User: "test"})
			for {
				time.Sleep(20 * time.Millisecond)
				if _, err := ch.SendRequest("heartbeat", true, nil); err != nil {
					return
				}
			}
		}
		fmt.Fprintln(ch, `{"ok":true}`)
		exitSSH(ch, 0)
	})
	cfg := Config{Host: host, Port: port, Claude: helper}
	path := filepath.Join(dir, "config.json")
	if err := writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	if err := ensureKey(dir); err != nil {
		t.Fatal(err)
	}
	remote := Transport{Config: cfg, Dir: dir, TrustNewHost: true, Log: io.Discard}
	if _, err := remote.Exec(context.Background(), "auth status --json", ""); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	t.Cleanup(func() { _ = controlCall(dir, "stop") })
	for i := 0; i < 2; i++ {
		if err := startBackground(ctx, path, io.Discard); err != nil {
			t.Fatal(err)
		}
		if err := startBackground(ctx, path, io.Discard); err != nil {
			t.Fatal("duplicate start", err)
		}
		if err := controlCall(dir, "status"); err != nil {
			t.Fatal(err)
		}
		if err := stopBackground(ctx, path, io.Discard); err != nil {
			t.Fatal(err)
		}
		if err := controlCall(dir, "status"); err == nil {
			t.Fatal("connector still running")
		}
	}
	if err := stopBackground(ctx, path, io.Discard); err != nil {
		t.Fatal("idempotent stop", err)
	}
}

// These tests use a real SSH transport and a subprocess speaking the actual
// Claude JSON/MCP boundary. They require neither provider credits nor credentials.
func testGateway(t *testing.T, handle func(string, ssh.Channel)) (string, int) {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil }}
	cfg.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var connections sync.Map
	t.Cleanup(func() { listener.Close(); connections.Range(func(k, v any) bool { k.(net.Conn).Close(); return true }) })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Store(conn, true)
			go func() {
				defer conn.Close()
				defer connections.Delete(conn)
				_, channels, requests, err := ssh.NewServerConn(conn, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					channel, requests, err := incoming.Accept()
					if err != nil {
						return
					}
					go func() {
						defer channel.Close()
						for req := range requests {
							if req.Type != "exec" {
								req.Reply(false, nil)
								continue
							}
							var command struct{ Value string }
							_ = ssh.Unmarshal(req.Payload, &command)
							req.Reply(true, nil)
							handle(command.Value, channel)
							return
						}
					}()
				}
			}()
		}
	}()
	host, portString, _ := net.SplitHostPort(listener.Addr().String())
	port, _ := strconv.Atoi(portString)
	return host, port
}

func exitSSH(channel ssh.Channel, code uint32) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{code}))
}

func helperExecutable(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "claude")
	// Test paths are shell-quoted; real connector invocations never use a shell.
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(exe, "'", "'\\''") + "' -test.run=TestAgentSubprocess -- \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FORK_AGENT_TEST_HELPER", "1")
	return path
}

func TestAgentSubprocess(t *testing.T) {
	if os.Getenv("FORK_AGENT_TEST_HELPER") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	args = args[1:]
	if args[0] == "--config" {
		if err := CLI(context.Background(), args, os.Stdin, os.Stdout, os.Stderr, "test"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if args[0] == "auth" {
		fmt.Println(`{"loggedIn":true}`)
		os.Exit(0)
	}
	if os.Getenv("FORK_AGENT_TEST_HANG") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	for _, flag := range []string{"--restricted", "--strict-mcp-config", "--tools", "--allowedTools"} {
		found := false
		for _, arg := range args {
			if arg == flag {
				found = true
			}
		}
		if !found {
			os.Exit(3)
		}
	}
	var config struct {
		Servers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	for i, arg := range args {
		if arg == "--mcp-config" {
			if json.Unmarshal([]byte(args[i+1]), &config) != nil {
				os.Exit(4)
			}
		}
	}
	server := config.Servers["fork"]
	cmd := exec.Command(server.Command, server.Args...)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		os.Exit(5)
	}
	enc := json.NewEncoder(in)
	dec := json.NewDecoder(out)
	for i, method := range []string{"initialize", "tools/list", "tools/call"} {
		params := map[string]any{"protocolVersion": "2025-03-26"}
		if method == "tools/call" {
			params = map[string]any{"name": "exec", "arguments": map[string]string{"command": "cat /README.md"}}
		}
		_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": i + 1, "method": method, "params": params})
		var response map[string]json.RawMessage
		if err := dec.Decode(&response); err != nil || response["error"] != nil {
			os.Exit(6)
		}
		if method == "tools/call" && !bytes.Contains(response["result"], []byte("Test Fork workspace")) {
			os.Exit(7)
		}
	}
	in.Close()
	if cmd.Wait() != nil {
		os.Exit(8)
	}
	if counter := os.Getenv("FORK_AGENT_TEST_COUNTER"); counter != "" {
		f, _ := os.OpenFile(counter, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		fmt.Fprintln(f, "run")
		f.Close()
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	fmt.Println(`{"result":"Готово: проверил проект.","session_id":"11111111-1111-4111-8111-111111111111","is_error":false}`)
	os.Exit(0)
}

func TestRunnerReconnectUsesSavedResultAndRealMCP(t *testing.T) {
	dir := t.TempDir()
	helper := helperExecutable(t)
	counter := filepath.Join(dir, "calls")
	t.Setenv("FORK_AGENT_TEST_COUNTER", counter)
	var completions atomic.Int32
	done := make(chan struct{}, 1)
	task := Task{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TopicID: "chat.test", Content: "Проверь проект"}
	host, port := testGateway(t, func(command string, ch ssh.Channel) {
		switch command {
		case "auth status --json":
			fmt.Fprintln(ch, `{"ok":true}`)
		case "agent-mode external --json":
			fmt.Fprintln(ch, `{"enabled":true}`)
		case "agent":
			_ = json.NewEncoder(ch).Encode(record{Type: "ready", Protocol: "fork-agent/1", User: "tester"})
			_ = json.NewEncoder(ch).Encode(record{Type: "task", Task: task})
			// Do not mistake the client's stdin EOF for a disconnected listener.
			requests := make(chan bool, 1)
			go func() {
				time.Sleep(100 * time.Millisecond)
				_, err := ch.SendRequest("heartbeat", true, nil)
				requests <- err == nil
			}()
			for {
				select {
				case <-time.After(20 * time.Millisecond):
					if _, err := ch.SendRequest("heartbeat", true, nil); err != nil {
						return
					}
				case <-requests:
				}
			}
		case "cat /README.md":
			fmt.Fprintln(ch, "Test Fork workspace")
		case "task-complete " + task.ID + " --json":
			body, _ := io.ReadAll(ch)
			if string(body) != "Готово: проверил проект." {
				t.Errorf("completion lost stdin: %q", body)
			}
			if completions.Add(1) == 1 {
				exitSSH(ch, 1)
				return
			}
			fmt.Fprintln(ch, `{"ok":true}`)
			done <- struct{}{}
		default:
			t.Errorf("unexpected remote command %q", command)
		}
		exitSSH(ch, 0)
	})
	cfg := Config{Host: host, Port: port, Claude: helper}
	path := filepath.Join(dir, "config.json")
	if err := writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	if err := ensureKey(dir); err != nil {
		t.Fatal(err)
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: io.Discard, TrustNewHost: true}
	if _, err := remote.Exec(context.Background(), "auth status --json", ""); err != nil {
		t.Fatal(err)
	}
	remote.TrustNewHost = false
	runner := Runner{Transport: remote, ConfigPath: path, Executable: helper, Timeout: 10 * time.Second, Log: io.Discard}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- runner.Run(ctx) }()
	select {
	case <-done:
	case err := <-finished:
		t.Fatalf("runner exited early: %v", err)
	case <-ctx.Done():
		t.Fatal("timed out waiting for retried receipt")
	}
	cancel()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not stop")
	}
	b, err := os.ReadFile(counter)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "run\n" || completions.Load() != 2 {
		t.Fatalf("Claude runs %q; completions %d", b, completions.Load())
	}
}

func TestClaudeTimeoutKillsSubprocess(t *testing.T) {
	helper := helperExecutable(t)
	t.Setenv("FORK_AGENT_TEST_HANG", "1")
	r := Runner{Transport: &Transport{Config: Config{Host: "localhost", Port: 22, Claude: helper}, Dir: t.TempDir()}, Timeout: 100 * time.Millisecond}
	started := time.Now()
	_, err := r.runClaude(context.Background(), "test", Task{TopicID: "test"})
	if err == nil || time.Since(started) > 3*time.Second {
		t.Fatalf("timeout did not stop process: %v", err)
	}
}

func TestConfigKeyPermissionsAndSingleRunner(t *testing.T) {
	dir := t.TempDir()
	if err := ensureKey(dir); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(dir, "id_ed25519"))
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	lock, err := lockState(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if duplicate, err := lockState(dir); err == nil {
		duplicate.Close()
		t.Fatal("duplicate runner accepted")
	}
}

func TestMCPRejectsUnknownTool(t *testing.T) {
	var out bytes.Buffer
	if err := ServeMCP(context.Background(), strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"local_shell\"}}\n"), &out, nil); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(&out)
	scanner.Scan()
	if !strings.Contains(scanner.Text(), `"isError":true`) {
		t.Fatal(scanner.Text())
	}
}

func TestAgentToolCannotChangeAuthenticationOrRouting(t *testing.T) {
	for _, command := range []string{"auth logout", "agent-mode internal", "task-complete id", "cat /README.md; auth logout", "cat /README.md && agent-mode internal", "cat /README.md\nauth logout", "cat /README.md | agent-mode internal"} {
		if err := validateRemoteCommand(command); err == nil {
			t.Fatalf("administrative command accepted: %q", command)
		}
	}
	for _, command := range []string{"cat /README.md", "cat > /apps/test/app.js", "sed -i 's/a;b/c;d/' /apps/test/app.js", "app push test -m 'Fix a && b' --json"} {
		if err := validateRemoteCommand(command); err != nil {
			t.Fatalf("development command rejected %q: %v", command, err)
		}
	}
}

// Opt-in smoke test against the installed, authenticated official Claude CLI.
// The only tool reads a synthetic README on a loopback SSH test server.
func TestClaudeLiveMCP(t *testing.T) {
	executable := os.Getenv("FORK_AGENT_LIVE_BINARY")
	if executable == "" {
		t.Skip("set FORK_AGENT_LIVE_BINARY to test the official Claude CLI")
	}
	claude, err := exec.LookPath("claude")
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	host, port := testGateway(t, func(command string, ch ssh.Channel) {
		if command == "cat /README.md" {
			calls.Add(1)
			fmt.Fprintln(ch, "FORK_AGENT_LIVE_OK")
		} else {
			fmt.Fprintln(ch, `[]`)
		}
		exitSSH(ch, 0)
	})
	dir := t.TempDir()
	cfg := Config{Host: host, Port: port, Claude: claude}
	path := filepath.Join(dir, "config.json")
	if err := ensureKey(dir); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(path, cfg); err != nil {
		t.Fatal(err)
	}
	remote := &Transport{Config: cfg, Dir: dir, TrustNewHost: true, Log: io.Discard}
	if _, err := remote.Exec(context.Background(), "cat /README.md", ""); err != nil {
		t.Fatal(err)
	}
	calls.Store(0)
	remote.TrustNewHost = false
	r := Runner{Transport: remote, ConfigPath: path, Executable: executable, Timeout: 90 * time.Second, Log: io.Discard}
	result, err := r.runClaude(context.Background(), "test", Task{TopicID: "live-test", Content: "Read /README.md using the Fork tool and reply with the exact one-line text in it. Do not edit anything."})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() == 0 || !strings.Contains(result, "FORK_AGENT_LIVE_OK") {
		t.Fatalf("Claude did not use the MCP tool: calls=%d result=%q", calls.Load(), result)
	}
}
