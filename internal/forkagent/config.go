// Package forkagent implements the user-owned Fork development connector.
// It runs the official Claude Code or Codex CLI without reading provider credentials.
package forkagent

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

type Config struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Agent  string `json:"agent,omitempty"`
	Claude string `json:"claude"`
	Codex  string `json:"codex,omitempty"`
	Model  string `json:"model,omitempty"`
}

func DefaultConfigPath() (string, error) {
	dir, err := os.UserConfigDir()
	return filepath.Join(dir, "fork-agent", "config.json"), err
}

func (c Config) Validate() error {
	if c.Host == "" || strings.ContainsAny(c.Host, "/\\@\r\n\t ") || strings.HasPrefix(c.Host, "-") {
		return fmt.Errorf("host must be a hostname or IP address, without a URL or username")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if c.Agent != "" && c.Agent != "claude" && c.Agent != "codex" {
		return fmt.Errorf("agent must be claude or codex")
	}
	if c.Executable() == "" {
		return fmt.Errorf("%s executable is not configured", c.AgentLabel())
	}
	return nil
}

func (c Config) AgentLabel() string {
	if c.Agent == "codex" {
		return "Codex"
	}
	return "Claude Code"
}

func (c Config) Executable() string {
	if c.Agent == "codex" {
		return c.Codex
	}
	return c.Claude
}

func (c *Config) resolveExecutable() error {
	executable, err := exec.LookPath(c.Executable())
	if err != nil {
		return fmt.Errorf("install the official %s CLI first: %w", c.AgentLabel(), err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	if c.Agent == "codex" {
		c.Codex = executable
	} else {
		c.Claude = executable
	}
	return nil
}

func (c Config) Address() string { return net.JoinHostPort(c.Host, strconv.Itoa(c.Port)) }

func LoadConfig(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("read config (run fork-agent login first): %w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

func writeJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writePrivate(path, append(b, '\n'))
}

// Rename only after fsync so a crash cannot leave half a receipt/configuration.
func writePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".fork-agent-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func ensureKey(dir string) error {
	path := filepath.Join(dir, "id_ed25519")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	block, err := ssh.MarshalPrivateKey(key, "fork-agent")
	if err != nil {
		return err
	}
	if err := writePrivate(path, pem.EncodeToMemory(block)); err != nil {
		return err
	}
	pub, err := ssh.NewPublicKey(key.Public())
	if err != nil {
		return err
	}
	return writePrivate(path+".pub", ssh.MarshalAuthorizedKey(pub))
}
