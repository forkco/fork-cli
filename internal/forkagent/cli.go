package forkagent

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/term"
)

const help = `fork — your Claude Code or Codex connected to Fork

Usage: fork [--config PATH] [COMMAND]

  (no command)     open your selected CLI with Fork tools
  start            start the Fork agent in the background
  stop             stop the agent; chat tasks stay queued for your server
  uninstall        stop, revoke this device and remove the Fork installation
  help             show these commands
  login [--host fork.me] [--agent claude|codex] [--model MODEL]
                   authorize a dedicated SSH key with a one-time Fork token
  run [--timeout 30m]  serve tasks; keep this terminal open or install the service
  status           show Fork identity and external execution mode
  mode external    keep tasks queued for your server, including while offline
  mode internal    explicitly return new tasks to Fork's paid internal agents
  service install  install and start a Linux systemd user service
  service uninstall  stop and remove the service (external mode stays enabled)
  version          print the connector version

Install from the command in Fork → Subscription. Agent sign-in runs locally.
Stopping Fork preserves external mode. Use 'mode internal' to return to
Fork generation. Group chats do not use the external agent.
`

func CLI(ctx context.Context, args []string, in *os.File, out, log io.Writer, version string) error {
	defaultPath, err := DefaultConfigPath()
	if err != nil {
		return err
	}
	global := flag.NewFlagSet("fork-agent", flag.ContinueOnError)
	global.SetOutput(log)
	configPath := global.String("config", defaultPath, "configuration file")
	global.Usage = func() { fmt.Fprint(out, help) }
	if err := global.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	args = global.Args()
	if len(args) == 0 {
		args = []string{"chat"}
	}
	if args[0] == "help" {
		fmt.Fprint(out, help)
		return nil
	}
	if args[0] == "version" {
		fmt.Fprintln(out, "fork "+version)
		return nil
	}
	path, err := filepath.Abs(*configPath)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if args[0] == "installed" {
		return recordInstallation(path, args[1:])
	}
	if args[0] == "setup" {
		return setup(ctx, path, args[1:], in, out, log)
	}
	if args[0] == "login" {
		return login(ctx, path, args[1:], in, out, log)
	}
	cfg, err := LoadConfig(path)
	if err != nil && args[0] == "uninstall" {
		return uninstall(ctx, path, Config{}, out)
	}
	if err != nil {
		return err
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: log}
	switch args[0] {
	case "chat":
		return interactive(path, cfg, in)
	case "start":
		if len(args) != 1 {
			return fmt.Errorf("usage: fork start")
		}
		if err := ensureAgentAuth(ctx, cfg, out, log); err != nil {
			return err
		}
		return startBackground(ctx, path, out)
	case "stop":
		if len(args) != 1 {
			return fmt.Errorf("usage: fork stop")
		}
		return stopBackground(ctx, path, out)
	case "uninstall":
		if len(args) != 1 {
			return fmt.Errorf("usage: fork uninstall")
		}
		return uninstall(ctx, path, cfg, out)
	case "mcp":
		return ServeMCP(ctx, in, out, remote)
	case "run":
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		flags.SetOutput(log)
		timeout := flags.Duration("timeout", 30*time.Minute, "maximum duration of each task")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *timeout <= 0 {
			return fmt.Errorf("usage: fork-agent run [--timeout 30m]")
		}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		runner := Runner{Transport: remote, ConfigPath: path, Executable: exe, Timeout: *timeout, Log: log}
		return runner.Run(ctx)
	case "status", "mode":
		command := "agent-mode status --json"
		if args[0] == "mode" {
			if len(args) != 2 || (args[1] != "internal" && args[1] != "external") {
				return fmt.Errorf("usage: fork-agent mode external|internal")
			}
			command = "agent-mode " + args[1] + " --json"
		} else if len(args) != 1 {
			return fmt.Errorf("usage: fork-agent status")
		}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if args[0] == "status" {
			result, err := remote.Exec(callCtx, "auth status --json", "")
			if err != nil {
				return err
			}
			fmt.Fprint(out, result)
		}
		result, err := remote.Exec(callCtx, command, "")
		if err != nil {
			return err
		}
		fmt.Fprint(out, result)
		return nil
	case "service":
		if len(args) != 2 {
			return fmt.Errorf("usage: fork-agent service install|uninstall")
		}
		return manageService(ctx, args[1], path, cfg, out)
	default:
		return fmt.Errorf("unknown command %q; run fork-agent help", args[0])
	}
}

func login(ctx context.Context, path string, args []string, in *os.File, out, log io.Writer) error {
	cfg := Config{Host: "fork.me", Port: 22, Claude: "claude", Codex: "codex"}
	if previous, err := LoadConfig(path); err == nil {
		cfg = previous
	}
	flags := flag.NewFlagSet("login", flag.ContinueOnError)
	flags.SetOutput(log)
	flags.StringVar(&cfg.Host, "host", cfg.Host, "Fork SSH gateway hostname")
	flags.IntVar(&cfg.Port, "port", cfg.Port, "Fork SSH gateway port (not the administrative SSH port)")
	flags.StringVar(&cfg.Agent, "agent", cfg.Agent, "claude or codex")
	flags.StringVar(&cfg.Claude, "claude", cfg.Claude, "official Claude Code executable")
	if cfg.Codex == "" {
		cfg.Codex = "codex"
	}
	flags.StringVar(&cfg.Codex, "codex", cfg.Codex, "official Codex executable")
	flags.StringVar(&cfg.Model, "model", cfg.Model, "agent model; omitted uses the provider default")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected login argument")
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := cfg.resolveExecutable(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	lock, err := lockState(dir)
	if err != nil {
		return err
	}
	defer lock.Close()
	if old, err := LoadConfig(path); err == nil && old.Address() != cfg.Address() {
		return fmt.Errorf("use a separate --config path for another Fork server")
	}
	if err := ensureKey(dir); err != nil {
		return err
	}
	remote := &Transport{Config: cfg, Dir: dir, Log: log, TrustNewHost: true}
	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result, authErr := remote.Exec(callCtx, "auth status --json", "")
	if authErr != nil {
		// Retry only an unbound/revoked key. Host-key, network and API failures
		// must not prompt for a token that could be sent to the wrong server.
		if !strings.Contains(result, "SSH_KEY_NOT_AUTHORIZED") {
			return authErr
		}
		fmt.Fprintf(log, "Open https://%s/auth and create a one-time SSH token.\nFork token: ", cfg.Host)
		var token string
		if term.IsTerminal(int(in.Fd())) {
			b, err := term.ReadPassword(int(in.Fd()))
			fmt.Fprintln(log)
			if err != nil {
				return err
			}
			token = strings.TrimSpace(string(b))
		} else {
			line, err := bufio.NewReader(io.LimitReader(in, 257)).ReadString('\n')
			if err != nil && err != io.EOF {
				return err
			}
			token = strings.TrimSpace(line)
		}
		if !validForkToken(token) {
			return fmt.Errorf("expected a one-time fk_ token (not a Claude token)")
		}
		result, err = remote.Exec(callCtx, "auth status --json", token+"\n")
		if err != nil {
			return err
		}
	}
	if err := writeJSON(path, cfg); err != nil {
		return err
	}
	fmt.Fprint(out, result)
	fmt.Fprintln(out, "Connected to Fork. Run 'claude auth login' if needed, then 'fork-agent run'.")
	return nil
}

func validForkToken(token string) bool {
	if len(token) != 51 || !strings.HasPrefix(token, "fk_") {
		return false
	}
	for _, c := range token[3:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func systemdQuote(s string) string {
	s = strings.ReplaceAll(s, "%", "%%")
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\r", "\\r")
	return "\"" + s + "\""
}

func serviceUnit(exe, config, searchPath string) string {
	return "[Unit]\nDescription=Fork personal development agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=" + systemdQuote(exe) + " --config " + systemdQuote(config) + " run\nEnvironment=" + systemdQuote("PATH="+searchPath) + "\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
}

func manageService(ctx context.Context, action, config string, cfg Config, out io.Writer) error {
	if runtime.GOOS != "linux" {
		return fmt.Errorf("systemd service installation is supported on Linux; run fork-agent run in a terminal on %s", runtime.GOOS)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	unit := filepath.Join(base, "systemd", "user", "fork-agent.service")
	run := func(args ...string) error {
		cmd := exec.CommandContext(ctx, "systemctl", append([]string{"--user"}, args...)...)
		cmd.Stdout, cmd.Stderr = out, out
		return cmd.Run()
	}
	switch action {
	case "install":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		searchPath := filepath.Dir(cfg.Executable()) + string(os.PathListSeparator) + os.Getenv("PATH")
		if err := writePrivate(unit, []byte(serviceUnit(exe, config, searchPath))); err != nil {
			return err
		}
		if err := run("daemon-reload"); err != nil {
			return err
		}
		if err := run("enable", "--now", "fork-agent.service"); err != nil {
			return err
		}
		fmt.Fprintln(out, "Service started. Logs: journalctl --user -u fork-agent -f\nTo keep it running after logout, enable lingering: loginctl enable-linger \"$USER\"")
	case "uninstall":
		if err := run("disable", "--now", "fork-agent.service"); err != nil {
			return err
		}
		if err := os.Remove(unit); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := run("daemon-reload"); err != nil {
			return err
		}
		fmt.Fprintln(out, "Service removed. External mode is still enabled; use 'fork-agent mode internal' to switch back.")
	default:
		return fmt.Errorf("usage: fork-agent service install|uninstall")
	}
	return nil
}
