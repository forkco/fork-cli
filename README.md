# Fork CLI

Connect your own **Claude Code or Codex** on a server to [Fork](https://fork.me).
Fork generation is **Free** with your own agent: no Fork subscription or Fork
Tokens are needed for these tasks. Your provider account and its limits still apply.

## Install and connect

In **Fork → Subscription**, choose the **Free · Your Claude or Codex** option below
the paid plans, select your agent, and click **Get install command**. Paste the
single line into your server terminal. It includes your own one-time Fork setup
token and the correct Fork host. The command downloads this repository's installer
and a checksummed binary from [GitHub Releases](https://github.com/forkco/fork-cli/releases).

The installer supports **Linux and macOS, amd64 and arm64**, installs the official
selected provider CLI if missing, opens its own sign-in flow when needed, and
starts the Fork connector in the background. Run as a normal user; the connector
requires no root account, Node.js, Go installation or inbound port.

```text
fork             Open Claude Code or Codex in your terminal with Fork tools
fork start       Start the background connector (safe to repeat)
fork stop        Stop; incoming tasks stay queued for your server
fork uninstall   Stop, revoke this device, remove Fork and restore an older fork
fork help        Show commands
fork status      Show the linked account and routing status
```

The same installation handles terminal chat and messages from your private Fork
chats. App files stay in Fork and are edited through its SSH virtual filesystem
via MCP. Background tasks use your own provider CLI and login. Stopping the
connector never silently switches to paid Fork generation. To switch back,
choose **Use Fork AI · Tokens** in Subscription or run `fork mode internal`.
Group chats continue using Fork's existing chat behavior.

Linux setup uses a systemd user service when available, otherwise a detached
process. Detached mode survives terminal closure. For restart after reboot use
`fork service install` and enable user lingering where permitted. Logs live
beside the configuration in `agent.log`.

### Install without linking an account

```sh
curl -fsSL https://github.com/forkco/fork-cli/releases/download/v0.3.0/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
fork help
```

Then use the personalized command from Subscription, or use legacy interactive
SSH enrollment: `fork login --host fork.me --agent claude` (or `codex`). It prompts
for a one-time SSH token from your Fork host's `/auth` page. Provider login stays
in the official CLI: `claude auth login` or `codex login --device-auth`.

## Credentials and state

Fork never reads provider credentials. The official CLI owns its login and runs
on your machine. The setup token expires after 15 minutes, is stored only as a
hash on Fork, and enrolls one dedicated Ed25519 SSH key. It is not saved in the
CLI configuration. Existing API keys and other devices are unaffected. Keep the
personalized command private and avoid saving it in shared shell history.

The first SSH connection pins the gateway host key; a changed key is rejected.
Config, dedicated key, pinned host key, private workspaces, per-chat provider
session IDs and completion receipts are in `~/.config/fork-agent` on Linux (the
standard user config directory on macOS). Use `fork --config PATH …` for another
account or host. A saved completion is resent on reconnect without regenerating
it. If interrupted before saving, a task can retry and must inspect existing
files before editing.

Uninstall removes only this Fork installation, its PATH block and SSH device;
provider CLIs remain installed. If revocation cannot reach Fork, revoke the
device in Fork settings. Private history and completion receipts are retained.

## Develop and release

Requires Go 1.25+ and Python 3 for subprocess integration tests.

```sh
make test
make build
make release VERSION=0.3.0
```

Release tags publish `install.sh`, four standalone binaries and SHA256SUMS. The installer verifies
the selected binary checksum before installation. No backend configuration,
secrets or private server source is included in this repository.

Official CLI documentation: [Claude Code](https://code.claude.com/docs/en/setup)
and [Codex](https://developers.openai.com/codex/cli).
