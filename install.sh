#!/bin/sh
set -eu

version=${FORK_CLI_VERSION:-0.3.0}
base=${FORK_AGENT_DOWNLOAD_BASE:-https://github.com/forkco/fork-cli/releases/download/v$version}
target=${INSTALL_DIR:-"$HOME/.local/bin"}
host=${FORK_HOST:-fork.me}
agent=claude
setup_token=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --token) [ "$#" -ge 2 ] || exit 1; setup_token=$2; shift 2 ;;
        --host) [ "$#" -ge 2 ] || exit 1; host=$2; shift 2 ;;
        --agent) [ "$#" -ge 2 ] || exit 1; agent=$2; shift 2 ;;
        *) echo 'Unknown installer option.' >&2; exit 1 ;;
    esac
done
case "$agent" in claude|codex) ;; *) echo 'Choose --agent claude or --agent codex.' >&2; exit 1 ;; esac
case "$host" in ''|-*|*[!a-zA-Z0-9.:-]*) echo 'Invalid Fork host.' >&2; exit 1 ;; esac
case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo 'Supported systems: Linux and macOS.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Supported architectures: amd64 and arm64.' >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo 'Install curl first.' >&2; exit 1; }
artifact="fork-agent-$platform-$arch"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM
curl -fsSL "$base/$artifact" -o "$temp/$artifact"
curl -fsSL "$base/SHA256SUMS" -o "$temp/SHA256SUMS"
expected=$(awk -v file="$artifact" '$2==file {print $1}' "$temp/SHA256SUMS")
case "$expected" in *[!0-9a-f]*|'') echo 'Invalid release checksum.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid release checksum.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temp/$artifact" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$temp/$artifact" | awk '{print $1}')
else
    echo 'Install sha256sum or shasum first.' >&2; exit 1
fi
[ "$expected" = "$actual" ] || { echo 'Release checksum mismatch; installation stopped.' >&2; exit 1; }
mkdir -p "$target"
previous=
if [ -e "$target/fork" ] || [ -L "$target/fork" ]; then
    if [ ! -e "$target/fork-agent" ] || [ ! "$target/fork" -ef "$target/fork-agent" ]; then
        previous="$target/fork.before-$(date +%s)-$$"
        mv "$target/fork" "$previous"
    fi
fi
install -m 755 "$temp/$artifact" "$target/.fork-new-$$"
mv -f "$target/.fork-new-$$" "$target/fork"
ln -sf fork "$target/fork-agent"
"$target/fork" installed --previous "$previous"
export PATH="$target:$HOME/.local/bin:$PATH"
echo "Installed $target/fork"
if [ -n "$setup_token" ]; then
    if [ "$agent" = claude ] && ! command -v claude >/dev/null 2>&1; then
        echo 'Installing official Claude Code…'
        curl -fsSL https://claude.ai/install.sh -o "$temp/claude-install.sh"
        bash "$temp/claude-install.sh"
    fi
    if [ "$agent" = codex ] && ! command -v codex >/dev/null 2>&1; then
        echo 'Installing official Codex CLI…'
        curl -fsSL https://chatgpt.com/codex/install.sh -o "$temp/codex-install.sh"
        sh "$temp/codex-install.sh"
    fi
    printf '%s\n' "$setup_token" | "$target/fork" setup --host "$host" --agent "$agent" --token-stdin
    unset setup_token
else
    echo "Connect using the install command in Fork → Subscription, or: $target/fork login --host $host --agent $agent"
fi
