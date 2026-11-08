package forkagent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

type Executor interface {
	Exec(context.Context, string, string) (string, error)
}

// Agent tools cannot change account authentication/routing or acknowledge their
// own task. Limit each call to one development command; file bytes use stdin.
func validateRemoteCommand(command string) error {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return fmt.Errorf("empty command")
	}
	switch fields[0] {
	case "help", "apps", "app", "files", "functions", "tables", "agents", "logs", "ls", "cat", "echo", "rm", "mv", "cp", "sed", "edit", "status", "diff", "push", "flush", "publish", "identify", "convert", "magick":
	default:
		return fmt.Errorf("only Fork development commands are available; account and task management belong to the connector")
	}
	var quote rune
	escaped := false
	for _, c := range command {
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if strings.ContainsRune(";|&\r\n", c) {
			return fmt.Errorf("use one command per call without chaining or pipelines; pass file content through stdin")
		}
	}
	if quote != 0 || escaped {
		return fmt.Errorf("unterminated command quote or escape")
	}
	return nil
}

// ServeMCP exposes only the Fork virtual shell. Claude has no local shell or
// filesystem tools in connector sessions, and no credential is placed in prompts.
func ServeMCP(ctx context.Context, in io.Reader, out io.Writer, remote Executor) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), 12<<20)
	encoder := json.NewEncoder(out)
	for scanner.Scan() {
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			return fmt.Errorf("invalid MCP JSON: %w", err)
		}
		if len(req.ID) == 0 {
			continue
		}
		response := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		switch req.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &p)
			version := "2024-11-05"
			switch p.ProtocolVersion {
			case "2024-11-05", "2025-03-26", "2025-06-18":
				version = p.ProtocolVersion
			}
			response["result"] = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "fork-agent", "version": "1"}}
		case "ping":
			response["result"] = map[string]any{}
		case "tools/list":
			response["result"] = map[string]any{"tools": []any{map[string]any{
				"name": "exec", "description": "Run one development command in the authenticated Fork virtual filesystem, NOT on the local server. Read cat /README.md first for the workflow. Supports apps, files, functions, tables, agents, logs and app check/push/publish; pass file contents through stdin. No command chaining, pipelines, account/task management, OS commands, npm or local paths. Each command starts at /.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"command": map[string]string{"type": "string"}, "stdin": map[string]string{"type": "string"}}, "required": []string{"command"}, "additionalProperties": false},
			}}}
		case "tools/call":
			var p struct {
				Name      string `json:"name"`
				Arguments struct {
					Command string `json:"command"`
					Stdin   string `json:"stdin"`
				} `json:"arguments"`
			}
			var result string
			var callErr error
			if err := json.Unmarshal(req.Params, &p); err != nil {
				callErr = err
			} else if p.Name != "exec" || p.Arguments.Command == "" {
				callErr = fmt.Errorf("unknown tool or empty command")
			} else if len(p.Arguments.Command) > 64<<10 || len(p.Arguments.Stdin) > 8<<20 {
				callErr = fmt.Errorf("command or stdin exceeds Fork limits")
			} else if err := validateRemoteCommand(p.Arguments.Command); err != nil {
				callErr = err
			} else {
				callCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
				result, callErr = remote.Exec(callCtx, p.Arguments.Command, p.Arguments.Stdin)
				cancel()
			}
			if callErr != nil {
				result += "\n" + callErr.Error()
			}
			response["result"] = map[string]any{"content": []any{map[string]string{"type": "text", "text": result}}, "isError": callErr != nil}
		default:
			response["error"] = map[string]any{"code": -32601, "message": "Method not found"}
		}
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}
