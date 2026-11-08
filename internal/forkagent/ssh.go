package forkagent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const maxOutput = 12 << 20

type Transport struct {
	Config       Config
	Dir          string
	Log          io.Writer
	TrustNewHost bool // only login may enroll a new host key
}

func (t *Transport) connect(ctx context.Context) (*ssh.Client, error) {
	key, err := os.ReadFile(filepath.Join(t.Dir, "id_ed25519"))
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return nil, err
	}
	hosts := filepath.Join(t.Dir, "known_hosts")
	f, err := os.OpenFile(hosts, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	check, err := knownhosts.New(hosts)
	if err != nil {
		return nil, err
	}
	callback := func(host string, remote net.Addr, key ssh.PublicKey) error {
		err := check(host, remote, key)
		if err == nil {
			return nil
		}
		var keyErr *knownhosts.KeyError
		if !t.TrustNewHost || !errors.As(err, &keyErr) || len(keyErr.Want) != 0 {
			return fmt.Errorf("SSH host key verification failed for %s: %w", host, err)
		}
		f, err := os.OpenFile(hosts, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := fmt.Fprintln(f, knownhosts.Line([]string{knownhosts.Normalize(host)}, key)); err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			return err
		}
		fmt.Fprintf(t.Log, "Trusted SSH host %s (%s)\n", host, ssh.FingerprintSHA256(key))
		return nil
	}
	conn, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", t.Config.Address())
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	sshConn, chans, requests, err := ssh.NewClientConn(conn, t.Config.Address(), &ssh.ClientConfig{
		User: "fork-agent", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: callback,
	})
	if err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(sshConn, chans, requests), nil
}

// boundedBuffer keeps draining SSH output after the limit, avoiding deadlocks.
type boundedBuffer struct {
	mu       sync.Mutex
	data     bytes.Buffer
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if b.data.Len()+len(p) > maxOutput {
		b.overflow = true
		p = p[:maxOutput-b.data.Len()]
	}
	b.data.Write(p)
	return n, nil
}
func (b *boundedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.data.String() }

func (t *Transport) Exec(ctx context.Context, command, input string) (string, error) {
	client, err := t.connect(ctx)
	if err != nil {
		return "", err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	var out, stderr boundedBuffer
	session.Stdout, session.Stderr, session.Stdin = &out, &stderr, bytes.NewBufferString(input)
	err = session.Run(command)
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if out.overflow || stderr.overflow {
		return "", fmt.Errorf("SSH output exceeds %d bytes", maxOutput)
	}
	if err != nil {
		// Do not include stdin: it can contain a one-time login token or file bytes.
		return out.String(), fmt.Errorf("Fork SSH: %w: %s", err, stderr.String())
	}
	return out.String(), nil
}
