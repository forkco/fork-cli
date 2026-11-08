package forkagent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func tomlString(value string) string { b, _ := json.Marshal(value); return string(b) }

// Command-line settings scope MCP and tools to this invocation. The official
// CLI keeps ownership of its authentication; Fork never opens auth.json.
func codexArguments(executable, config, prompt string) []string {
	server := `mcp_servers={fork={command=` + tomlString(executable) + `,args=["--config",` + tomlString(config) + `,"mcp"],required=true,enabled_tools=["exec"],tools={exec={approval_mode="approve"}}}}`
	return []string{"-c", server,
		"-c", "features.shell_tool=false", "-c", "features.multi_agent=false",
		"-c", `web_search="disabled"`, "-c", `approval_policy="never"`,
		"-c", `sandbox_mode="read-only"`, "-c", "developer_instructions=" + tomlString(prompt)}
}

func (r *Runner) runCodex(parent context.Context, user string, task Task) (string, error) {
	ctx, cancel := context.WithTimeout(parent, r.Timeout)
	defer cancel()
	topic := digest([]byte(r.Transport.Config.Address() + "\x00" + user + "\x00" + task.TopicID))
	workdir := filepath.Join(r.Transport.Dir, "workspaces", "codex-"+topic)
	if err := os.MkdirAll(workdir, 0700); err != nil {
		return "", err
	}
	sessionPath := filepath.Join(r.Transport.Dir, "sessions", "codex-"+topic+".json")
	var previous struct {
		ID string `json:"id"`
	}
	if b, err := os.ReadFile(sessionPath); err == nil {
		if err := json.Unmarshal(b, &previous); err != nil {
			return "", err
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	args := codexArguments(r.Executable, r.ConfigPath, workflow)
	if r.Transport.Config.Model != "" {
		args = append(args, "--model", r.Transport.Config.Model)
	}
	args = append(args, "exec", "--ignore-user-config", "--ignore-rules", "--json", "--skip-git-repo-check")
	if previous.ID != "" {
		args = append(args, "resume", previous.ID)
	}
	args = append(args, "-")
	input, _ := json.Marshal(task)
	cmd := exec.CommandContext(ctx, r.Transport.Config.Codex, args...)
	cmd.Dir, cmd.Stdin = workdir, strings.NewReader("Execute this Fork task:\n"+string(input))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 3 * time.Second
	var output, stderr boundedBuffer
	cmd.Stdout, cmd.Stderr = &output, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", fmt.Errorf("Codex: %w: %s", err, stderr.String())
	}
	if output.overflow {
		return "", fmt.Errorf("Codex output exceeds limit")
	}
	result, session, err := parseCodexResult(output.String())
	if err != nil {
		return "", err
	}
	if session != "" {
		if err := writeJSON(sessionPath, map[string]string{"id": session}); err != nil {
			return "", err
		}
	}
	return result, nil
}

func parseCodexResult(output string) (result, session string, err error) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 4096), 8<<20)
	completed := false
	for scanner.Scan() {
		var event struct {
			Type     string `json:"type"`
			ThreadID string `json:"thread_id"`
			Item     struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return "", "", fmt.Errorf("invalid Codex event: %w", err)
		}
		switch event.Type {
		case "thread.started":
			session = event.ThreadID
		case "item.completed":
			if event.Item.Type == "agent_message" {
				result = event.Item.Text
			}
		case "turn.completed":
			completed = true
		case "turn.failed", "error":
			return "", "", fmt.Errorf("Codex returned %s", event.Type)
		}
	}
	if err := scanner.Err(); err != nil {
		return "", "", err
	}
	if !completed || strings.TrimSpace(result) == "" {
		return "", "", fmt.Errorf("Codex did not complete a response")
	}
	return result, session, nil
}
