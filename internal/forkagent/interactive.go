package forkagent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/term"
)

func mcpConfiguration(executable, config string) string {
	b, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"fork": map[string]any{"command": executable, "args": []string{"--config", config, "mcp"}}}})
	return string(b)
}

// Replace the wrapper so Claude owns terminal signals, resize events and its
// normal interactive UI. No provider credentials are read by Fork.
var interactiveExec = syscall.Exec

func interactive(config string, cfg Config, input *os.File) error {
	if !term.IsTerminal(int(input.Fd())) {
		return fmt.Errorf("run fork in an interactive terminal; use fork start for background tasks")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Join(filepath.Dir(config), "workspaces", "terminal")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chdir(dir); err != nil {
		return err
	}
	prompt := strings.ReplaceAll(workflow, "Finish with a concise summary in the user's language; the connector sends it to the original Fork chat.", "Reply directly in this terminal in the user's language.")
	if cfg.Agent == "codex" {
		args := append([]string{cfg.Codex}, codexArguments(executable, config, prompt)...)
		if cfg.Model != "" {
			args = append(args, "--model", cfg.Model)
		}
		return interactiveExec(cfg.Codex, args, os.Environ())
	}
	args := []string{cfg.Claude, "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", mcpConfiguration(executable, config), "--allowedTools", "mcp__fork__exec", "--setting-sources", "", "--disable-slash-commands", "--append-system-prompt", prompt}
	if cfg.Model != "" {
		args = append(args, "--model", cfg.Model)
	}
	return interactiveExec(cfg.Claude, args, os.Environ())
}
