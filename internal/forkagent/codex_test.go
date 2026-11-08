package forkagent

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestCodexResultsRequireCompletedTurn(t *testing.T) {
	for _, tc := range []struct {
		name, events string
		ok           bool
	}{
		{"complete", "{\"type\":\"thread.started\",\"thread_id\":\"thread-a\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Done\"}}\n{\"type\":\"turn.completed\"}\n", true},
		{"unfinished", "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Partial\"}}\n", false},
		{"failed", "{\"type\":\"turn.failed\"}\n", false},
		{"empty", "{\"type\":\"turn.completed\"}\n", false},
		{"invalid", "broken JSON\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, session, err := parseCodexResult(tc.events)
			if (err == nil) != tc.ok {
				t.Fatalf("unexpected result: %q %v", result, err)
			}
			if tc.ok && (result != "Done" || session != "thread-a") {
				t.Fatalf("lost result/session: %q %q", result, session)
			}
		})
	}
}

func TestCodexLiveMCP(t *testing.T) {
	executable := os.Getenv("FORK_AGENT_LIVE_BINARY")
	if executable == "" || os.Getenv("FORK_AGENT_LIVE_CODEX") != "1" {
		t.Skip("set FORK_AGENT_LIVE_BINARY to test the official Codex CLI")
	}
	codex, err := exec.LookPath("codex")
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
	cfg := Config{Host: host, Port: port, Agent: "codex", Codex: codex}
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
	r := Runner{Transport: remote, ConfigPath: path, Executable: executable, Timeout: 120 * time.Second, Log: io.Discard}
	result, err := r.runCodex(context.Background(), "test", Task{TopicID: "live-test", Content: "Read /README.md using the Fork tool and reply with the exact one-line text in it. Do not edit anything."})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() == 0 || !strings.Contains(result, "FORK_AGENT_LIVE_OK") {
		t.Fatalf("Codex did not use the MCP tool: calls=%d result=%q", calls.Load(), result)
	}
	result, err = r.runCodex(context.Background(), "test", Task{TopicID: "live-test", Content: "Read /README.md again using the Fork tool and repeat its exact text."})
	if err != nil || !strings.Contains(result, "FORK_AGENT_LIVE_OK") {
		t.Fatalf("resume failed: %v %q", err, result)
	}
}
