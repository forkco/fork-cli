package forkagent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestLoginBindsKeyWithoutSavingTokenAndRejectsChangedHost(t *testing.T) {
	helper := helperExecutable(t)
	dir := t.TempDir()
	token := "fk_" + strings.Repeat("a", 48)
	var authorized atomic.Bool
	host, port := testGateway(t, func(command string, ch ssh.Channel) {
		if command != "auth status --json" {
			t.Error(command)
		}
		body, _ := io.ReadAll(ch)
		if !authorized.Load() && string(body) != token+"\n" {
			fmt.Fprintln(ch, `{"error":{"code":"SSH_KEY_NOT_AUTHORIZED"}}`)
			exitSSH(ch, 77)
			return
		}
		authorized.Store(true)
		fmt.Fprintln(ch, `{"ok":true,"handle":"test"}`)
		exitSSH(ch, 0)
	})
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	fmt.Fprintln(writer, token)
	writer.Close()
	var output bytes.Buffer
	path := filepath.Join(dir, "config.json")
	if err := login(context.Background(), path, []string{"--host", host, "--port", strconv.Itoa(port), "--claude", helper}, input, &output, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !authorized.Load() {
		t.Fatal("key was not bound")
	}
	files, _ := os.ReadDir(dir)
	for _, file := range files {
		body, _ := os.ReadFile(filepath.Join(dir, file.Name()))
		if bytes.Contains(body, []byte(token)) {
			t.Fatalf("token persisted in %s", file.Name())
		}
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: io.Discard}
	if _, err := remote.Exec(context.Background(), "auth status --json", ""); err != nil {
		t.Fatal("registered key required token again", err)
	}
	_, newKey, _ := ed25519.GenerateKey(rand.Reader)
	wrong, _ := ssh.NewPublicKey(newKey.Public())
	if err := os.WriteFile(filepath.Join(dir, "known_hosts"), []byte(knownhosts.Line([]string{knownhosts.Normalize(cfg.Address())}, wrong)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	remote.TrustNewHost = true // even login must never replace an existing key
	if _, err := remote.Exec(context.Background(), "auth status --json", ""); err == nil || !strings.Contains(err.Error(), "host key") {
		t.Fatal("changed host accepted", err)
	}
}
