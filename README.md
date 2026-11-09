# Fork CLI

A compact Rust connector for your own Claude Code or Codex. One executable, HTTPS task events, local app workspaces and optional **Virtual computer**.

Version 0.4 uses the new HTTPS endpoints. Deploy the matching Fork backend before enabling it; the 0.3 SSH connector is retained in Git history.

## Install

In **Fork → Subscription → Your Claude or Codex**, select your agent and optionally **Virtual computer**, then copy your personalized one-line command. Its enrollment capability expires in 15 minutes and creates a separate revocable HTTP device key. Existing devices and API keys are untouched.

The installer downloads a checksummed executable from GitHub Releases. When Virtual computer is selected, it also downloads the optional package, reuses Node 24+ or installs a private Node runtime, installs pinned dependencies, and downloads Chromium if no configured browser is available. Node and Chromium are not part of the small core executable. Linux needs Chromium's OS dependencies and a working sandbox; use an unprivileged account. The installer does not request root privileges or disable browser sandboxing.

```text
fork                  Interactive official agent in the current directory
fork start            Start the background HTTPS task connector
fork stop             Stop; tasks stay queued for this server
fork uninstall        Stop, revoke this device and remove this installation
fork help             Show commands
fork pull APP_ID      Download all logical app files into the current directory
fork push             Upload an immutable 24-hour preview, without publication
fork save             Commit local edits as an app version (checks base revision)
fork test             Check the pushed preview with the optional Virtual computer
fork app-create TITLE SLUG
```

## Local editing and preview

App tasks download a complete logical snapshot into a private temporary workspace: frontend files, functions, agents, chat views and schemas. The official agent uses normal file/edit/shell tools. Its instructions explain `fork push` and the task-scoped computer tool. Final edits are also pushed as a preview automatically. Preview URLs use separate random subdomains, so root-relative assets work and user app HTML never runs on the Fork account origin. Previews expire after 24 hours. They do not publish or overwrite the saved app. Conflicting saved revisions return HTTP 409 instead of overwriting another edit.

The preview serves frontend files. It does not execute unpublished backend functions or provision cloned databases. Test those changes separately before publication.

The connector streams task events with heartbeats. A lost stream cancels the running agent and unfinished tasks are requeued. Saved completion receipts are resent after reconnect, preventing duplicate replies after an ambiguous completion request.

## Virtual computer

The optional package uses Fork computer's existing browser/workspace engine. Its local adapter speaks MCP over stdio; there is no public control listener and no Fork service credential. The Node adapter is scoped to an agent invocation. The checked-IP egress proxy and sandboxed browser start on the first actual computer command, then close when the invocation ends. Browser, tabs, clicking, input, inspection, screenshots, downloads and virtual workspace tools are available. Closing the browser explicitly is encouraged.

The core task listener remains in the background; the Virtual computer does not run continuously. A plain chat does not start Chromium. A build can open its pushed preview, interact with it and verify the result. `fork test` is a one-request browser check that closes its computer when finished.

Set `FORK_CHROME` to reuse a compatible installed browser. The installer remembers that executable for later starts from a fresh shell; an empty MCP environment value does not erase it. `FORK_CONFIG_DIR` isolates an installation for testing or another account. Config and device credentials are private; provider sign-in remains owned by the official agent CLI. Temporary app workspaces remain under the system temp directory for inspection and can be removed after use.

## Environments and usage history

Production install commands use the default `fork.me`; staging commands add
`--host fork.cx`. In v0.4.2 the connector includes provider input, output and cache
counters in its durable completion receipts. Fork lists these separately as your
server's usage, with zero Fork Tokens charged. Receipt retries do not count them
again. Provider tokens are not converted into Fork Tokens and do not enter Fork's
cost statistics. Claude cache counts are additional to its uncached input; Codex
cached input is a subset of its total input. Missing counters remain unknown.

## Build

```sh
cargo test --locked
cargo build --release --locked
```

The source includes the legacy Go implementation for compatibility reference; current builds use `rust/main.rs`. Release jobs build Linux/macOS amd64/arm64 executables and package the optional computer separately. All public installer assets come from the corresponding GitHub Release.

Version 0.4.4 announces the configured agent on its HTTPS session. Fork shows Host Claude or Host Codex at the top of the model picker and notifies you on connection. The host option uses your official CLI’s configured default model.


Version 0.4.5 adds a native model submenu inside Host. Its catalog comes from your
installed Claude or Codex CLI, without an inference request or provider credentials
being sent to Fork. Auto uses the native default; an explicit choice is passed as
`--model`. Run `fork models` to inspect the catalog. Model-specific work waits for
a supporting connector rather than falling back to a paid Fork model. Ordinary
dashboard/public chat does not try to download an application workspace.

### Updates

Run `fork update` to install the latest stable release. Downloads come from this
public repository and are checked against its `SHA256SUMS` and embedded version
before replacing the binary. `fork update --force` reinstalls the current release.
Settings, device credentials and the optional Virtual computer are preserved.
An active task finishes before replacement; the background runner restarts when
it was running. If the new runner fails to start, the previous binary is restored.

Fork also offers an update in the web interface when a newer release is available.
Click **Update** to approve that specific version for that device. The approval
expires after 24 hours. No update is installed without this approval or a local
`fork update` command. Initial versions older than v0.4.7 need a one-time installer
upgrade before web-approved updates are supported.

Chat icons are selected by your own agent in the same response. The connector
strips the transport metadata before publishing the answer and preserves existing
icons. The prompt is in [`rust/chat-metadata-prompt.md`](rust/chat-metadata-prompt.md).

### v0.4.8: native web tools and failures

Claude tasks allow WebSearch and WebFetch with or without Virtual computer. An
optional tool permission denial does not mark a normally completed reply as a
failed turn. Connector chat metadata is removed before both success and failure
handling. Terminal failures carry a separate bounded failure receipt; the web
interface shows a localized error instead of native diagnostics.
