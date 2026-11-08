package forkagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// A private Unix socket identifies the actual connector, avoiding stale PID
// files and ever signalling a different process after PID reuse.
func controlPath(dir string) string {
	path := filepath.Join(dir, "agent.sock")
	if len(path) > 90 {
		path = filepath.Join("/tmp", "fork-"+strconv.Itoa(os.Geteuid())+"-"+digest([]byte(dir))[:16], "agent.sock")
	}
	return path
}
func controlCall(dir, command string) error {
	conn, err := net.DialTimeout("unix", controlPath(dir), 500*time.Millisecond)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if err := json.NewEncoder(conn).Encode(map[string]string{"command": command}); err != nil {
		return err
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if err := json.NewDecoder(conn).Decode(&result); err != nil {
		return err
	}
	if !result.OK {
		return errors.New("connector rejected control request")
	}
	return nil
}
func serveControl(ctx context.Context, cancel context.CancelFunc, dir string) (net.Listener, error) {
	// Caller holds run.lock, so removing a stale socket cannot affect another runner.
	path := controlPath(dir)
	if filepath.Dir(path) != dir {
		parent := filepath.Dir(path)
		if err := os.Mkdir(parent, 0700); err != nil && !os.IsExist(err) {
			return nil, err
		}
		info, err := os.Lstat(parent)
		if err != nil {
			return nil, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.IsDir() || info.Mode().Perm()&0077 != 0 || !ok || int(stat.Uid) != os.Geteuid() {
			return nil, fmt.Errorf("unsafe control socket directory")
		}
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	go func() {
		defer stop()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			var request struct {
				Command string `json:"command"`
			}
			err = json.NewDecoder(io.LimitReader(conn, 1024)).Decode(&request)
			ok := err == nil && (request.Command == "status" || request.Command == "stop")
			_ = json.NewEncoder(conn).Encode(map[string]any{"ok": ok, "pid": os.Getpid()})
			conn.Close()
			if ok && request.Command == "stop" {
				cancel()
				return
			}
		}
	}()
	return listener, nil
}

func matchingService(config string) bool {
	base, err := os.UserConfigDir()
	if err != nil {
		return false
	}
	b, err := os.ReadFile(filepath.Join(base, "systemd", "user", "fork-agent.service"))
	return err == nil && strings.Contains(string(b), " --config "+systemdQuote(config)+" run\n")
}

func startBackground(ctx context.Context, config string, out io.Writer) error {
	dir := filepath.Dir(config)
	if controlCall(dir, "status") == nil {
		fmt.Fprintln(out, "Fork is already running in the background.")
		return nil
	}
	if matchingService(config) {
		cmd := exec.CommandContext(ctx, "systemctl", "--user", "start", "fork-agent.service")
		if err := cmd.Run(); err == nil {
			return waitForBackground(ctx, dir, nil, out)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(dir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	input, err := os.Open(os.DevNull)
	if err != nil {
		return err
	}
	defer input.Close()
	cmd := exec.Command(executable, "--config", config, "run")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	err = waitForBackground(ctx, dir, exited, out)
	if err != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
	return err
}

func waitForBackground(ctx context.Context, dir string, exited <-chan error, out io.Writer) error {
	deadline := time.NewTimer(50 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		if controlCall(dir, "status") == nil {
			fmt.Fprintln(out, "Fork is running in the background.\nStop: fork stop · Interactive: fork · Help: fork help")
			return nil
		}
		select {
		case err := <-exited:
			return fmt.Errorf("background start failed (%v); see %s", err, filepath.Join(dir, "agent.log"))
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("background start timed out; see %s", filepath.Join(dir, "agent.log"))
		case <-ticker.C:
		}
	}
}

func stopBackground(ctx context.Context, config string, out io.Writer) error {
	dir := filepath.Dir(config)
	if matchingService(config) {
		cmd := exec.CommandContext(ctx, "systemctl", "--user", "stop", "fork-agent.service")
		if err := cmd.Run(); err != nil && controlCall(dir, "status") == nil {
			return fmt.Errorf("stop systemd service: %w", err)
		}
	}
	if err := controlCall(dir, "stop"); err != nil {
		// A held flock with no control socket can be an older/starting connector.
		lock, lockErr := lockState(dir)
		if lockErr != nil {
			return fmt.Errorf("connector is starting or uses an older foreground session; stop that session before uninstalling")
		}
		lock.Close()
		fmt.Fprintln(out, "Fork is stopped.")
		return nil
	}
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		lock, err := lockState(dir)
		if err == nil {
			lock.Close()
			fmt.Fprintln(out, "Fork stopped. New messages will wait for your server.")
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("Fork is still finishing shutdown; try fork stop again")
		case <-ticker.C:
		}
	}
}
