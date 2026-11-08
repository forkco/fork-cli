package forkagent

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func setup(ctx context.Context, path string, args []string, in *os.File, out, log io.Writer) error {
	cfg := Config{Host: "fork.me", Port: 22, Claude: "claude", Codex: "codex"}
	if old, err := LoadConfig(path); err == nil {
		cfg = old
	}
	flags := flag.NewFlagSet("setup", flag.ContinueOnError)
	flags.SetOutput(log)
	flags.StringVar(&cfg.Host, "host", cfg.Host, "Fork host")
	flags.IntVar(&cfg.Port, "port", cfg.Port, "Fork SSH gateway port")
	flags.StringVar(&cfg.Agent, "agent", cfg.Agent, "claude or codex")
	flags.StringVar(&cfg.Claude, "claude", cfg.Claude, "official Claude Code executable")
	if cfg.Codex == "" {
		cfg.Codex = "codex"
	}
	flags.StringVar(&cfg.Codex, "codex", cfg.Codex, "official Codex executable")
	tokenStdin := flags.Bool("token-stdin", false, "read the one-time setup token from stdin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !*tokenStdin {
		return fmt.Errorf("setup requires --token-stdin; get your install command in Fork Subscription")
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if old, err := LoadConfig(path); err == nil && old.Address() != cfg.Address() {
		return fmt.Errorf("use a separate --config directory for another Fork server")
	}
	tokenBytes, err := io.ReadAll(io.LimitReader(in, 1024))
	if err != nil {
		return err
	}
	token := strings.TrimSpace(string(tokenBytes))
	if len(token) != 68 || !strings.HasPrefix(token, "fks_") {
		return fmt.Errorf("invalid setup token; get a new install command in Subscription")
	}
	if _, err := hex.DecodeString(token[4:]); err != nil {
		return fmt.Errorf("invalid setup token")
	}
	if err := cfg.resolveExecutable(); err != nil {
		return err
	}
	if old, err := LoadConfig(path); err == nil && old.Agent != cfg.Agent {
		cfg.Model = ""
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Updating an existing installation pauses its runner before changing auth/config.
	if _, err := os.Stat(path); err == nil {
		if err := stopBackground(ctx, path, io.Discard); err != nil {
			return err
		}
	}
	lock, err := lockState(dir)
	if err != nil {
		return err
	}
	if err := ensureKey(dir); err != nil {
		lock.Close()
		return err
	}
	pub, err := os.ReadFile(filepath.Join(dir, "id_ed25519.pub"))
	if err != nil {
		lock.Close()
		return err
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "server"
	}
	err = writeJSON(path, cfg)
	if err == nil {
		err = enroll(ctx, &http.Client{Timeout: 30 * time.Second}, "https://"+cfg.Host, token, string(pub), "Fork CLI · "+name)
	}
	lock.Close()
	if err != nil {
		return err
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: log, TrustNewHost: true}
	if _, err := remote.Exec(ctx, "auth status --json", ""); err != nil {
		return err
	}
	fmt.Fprintln(out, "Fork account connected.")
	if err := ensureAgentAuth(ctx, cfg, out, log); err != nil {
		return err
	}
	if err := installShellPath(dir); err != nil {
		return err
	}
	// systemd is an optional upgrade; detached mode works without a user bus.
	if runtime.GOOS == "linux" && exec.CommandContext(ctx, "systemctl", "--user", "show-environment").Run() == nil {
		if current, err := user.Current(); err == nil {
			_ = exec.CommandContext(ctx, "loginctl", "--no-ask-password", "enable-linger", current.Username).Run()
		}
		if err := manageService(ctx, "install", path, cfg, io.Discard); err == nil {
			return waitForBackground(ctx, dir, nil, out)
		}
	}
	return startBackground(ctx, path, out)
}

func enroll(ctx context.Context, client *http.Client, origin, token, publicKey, name string) error {
	body, _ := json.Marshal(map[string]string{"token": token, "public_key": publicKey, "name": name})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+"/api/auth/cli/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to Fork: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("Fork enrollment: %s", strings.TrimSpace(string(message)))
	}
	return nil
}

func authArguments(cfg Config, login bool) []string {
	if cfg.Agent == "codex" {
		if login {
			return []string{"login", "--device-auth"}
		}
		return []string{"login", "status"}
	}
	if login {
		return []string{"auth", "login"}
	}
	return []string{"auth", "status"}
}

func checkAgentAuth(ctx context.Context, cfg Config) error {
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(checkCtx, cfg.Executable(), authArguments(cfg, false)...)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	return cmd.Run()
}

func ensureAgentAuth(ctx context.Context, cfg Config, out, log io.Writer) error {
	if checkAgentAuth(ctx, cfg) == nil {
		return nil
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("sign in with '%s %s', then run 'fork start'", cfg.Executable(), strings.Join(authArguments(cfg, true), " "))
	}
	defer tty.Close()
	fmt.Fprintf(out, "Sign in to %s to finish setup:\n", cfg.AgentLabel())
	cmd := exec.CommandContext(ctx, cfg.Executable(), authArguments(cfg, true)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, out, log
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s sign-in was not completed; run 'fork' to sign in, then 'fork start': %w", cfg.AgentLabel(), err)
	}
	return nil
}

type installation struct {
	Executable string   `json:"executable"`
	Previous   string   `json:"previous,omitempty"`
	Profiles   []string `json:"profiles,omitempty"`
}

func installationPath(dir string) string { return filepath.Join(dir, "installation.json") }
func recordInstallation(path string, args []string) error {
	flags := flag.NewFlagSet("installed", flag.ContinueOnError)
	previous := flags.String("previous", "", "")
	if err := flags.Parse(args); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	var state installation
	if b, err := os.ReadFile(installationPath(filepath.Dir(path))); err == nil {
		if err := json.Unmarshal(b, &state); err != nil {
			return err
		}
	}
	if *previous != "" {
		absolute, err := filepath.Abs(*previous)
		if err != nil {
			return err
		}
		if filepath.Dir(absolute) != filepath.Dir(exe) || !strings.HasPrefix(filepath.Base(absolute), "fork.before-") {
			return fmt.Errorf("invalid previous executable path")
		}
		state.Previous = absolute
	}
	state.Executable = exe
	return writeJSON(installationPath(filepath.Dir(path)), state)
}

const profileBlock = "\n# >>> Fork CLI >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< Fork CLI <<<\n"

func installShellPath(dir string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	var state installation
	if b, err := os.ReadFile(installationPath(dir)); err == nil {
		if err := json.Unmarshal(b, &state); err != nil {
			return err
		}
	}
	profiles := []string{filepath.Join(home, ".profile")}
	for _, name := range []string{".bashrc", ".zshrc", ".zprofile"} {
		path := filepath.Join(home, name)
		_, statErr := os.Stat(path)
		if statErr == nil || strings.Contains(os.Getenv("SHELL"), "zsh") && name != ".bashrc" {
			profiles = append(profiles, path)
		}
	}
	for _, path := range profiles {
		b, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if strings.Contains(string(b), "# >>> Fork CLI >>>") {
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = file.WriteString(profileBlock)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		found := false
		for _, existing := range state.Profiles {
			if existing == path {
				found = true
			}
		}
		if !found {
			state.Profiles = append(state.Profiles, path)
		}
	}
	return writeJSON(installationPath(dir), state)
}

func uninstall(ctx context.Context, path string, cfg Config, out io.Writer) error {
	if err := stopBackground(ctx, path, io.Discard); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if matchingService(path) {
		if err := manageService(ctx, "uninstall", path, cfg, io.Discard); err != nil {
			return err
		}
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: io.Discard}
	revokeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	var revokeErr error
	if cfg.Host != "" {
		_, revokeErr = remote.Exec(revokeCtx, "auth logout --json", "")
	}
	cancel()
	var state installation
	if b, err := os.ReadFile(installationPath(dir)); err == nil {
		if err := json.Unmarshal(b, &state); err != nil {
			return err
		}
	}
	for _, profile := range state.Profiles {
		b, err := os.ReadFile(profile)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		clean := strings.ReplaceAll(string(b), profileBlock, "")
		if clean != string(b) {
			info, err := os.Stat(profile)
			if err != nil {
				return err
			}
			if err := os.WriteFile(profile, []byte(clean), info.Mode().Perm()); err != nil {
				return err
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	current, err := os.Stat(exe)
	if err != nil {
		return err
	}
	if state.Executable != "" {
		installed, err := os.Stat(state.Executable)
		if err == nil && os.SameFile(current, installed) {
			alias := filepath.Join(filepath.Dir(state.Executable), "fork-agent")
			if info, err := os.Stat(alias); err == nil && os.SameFile(info, current) {
				if err := os.Remove(alias); err != nil {
					return err
				}
			}
			if err := os.Remove(state.Executable); err != nil {
				return err
			}
			if state.Previous != "" && filepath.Dir(state.Previous) == filepath.Dir(state.Executable) && strings.HasPrefix(filepath.Base(state.Previous), "fork.before-") {
				if err := os.Rename(state.Previous, state.Executable); err != nil && !os.IsNotExist(err) {
					return err
				}
			}
		}
	}
	for _, file := range []string{path, filepath.Join(dir, "id_ed25519"), filepath.Join(dir, "id_ed25519.pub"), filepath.Join(dir, "known_hosts"), installationPath(dir)} {
		if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	fmt.Fprintln(out, "Fork stopped and uninstalled. Chat tasks stay queued; choose Fork AI in Subscription to change routing.")
	if revokeErr != nil {
		fmt.Fprintln(out, "The server was unreachable. Revoke this SSH device in Fork settings.")
	}
	return nil
}
