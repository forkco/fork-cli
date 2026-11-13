#!/bin/sh
set -eu

version=${FORK_CLI_VERSION:-0.4.19}
base=${FORK_AGENT_DOWNLOAD_BASE:-https://github.com/forkco/fork-cli/releases/download/v$version}
target=${INSTALL_DIR:-"$HOME/.local/bin"}
host=${FORK_HOST:-fork.me}
agent=claude
virtual_computer=false
setup_token=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --token) [ "$#" -ge 2 ] || exit 1; setup_token=$2; shift 2 ;;
        --host) [ "$#" -ge 2 ] || exit 1; host=$2; shift 2 ;;
        --agent) [ "$#" -ge 2 ] || exit 1; agent=$2; shift 2 ;;
        --virtual-computer) [ "$#" -ge 2 ] || exit 1; virtual_computer=$2; shift 2 ;;
        *) echo 'Unknown installer option.' >&2; exit 1 ;;
    esac
done
case "$virtual_computer" in true|false) ;; *) echo "Virtual computer must be true or false." >&2; exit 1 ;; esac
case "$agent" in claude|codex) ;; *) echo 'Choose --agent claude or --agent codex.' >&2; exit 1 ;; esac
case "$host" in ''|-*|*[!a-zA-Z0-9.:-]*) echo 'Invalid Fork host.' >&2; exit 1 ;; esac
case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo 'Supported systems: Linux and macOS.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Supported architectures: amd64 and arm64.' >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { echo 'Install curl first.' >&2; exit 1; }
artifact="fork-agent-$platform-$arch"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM
curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$base/$artifact" -o "$temp/$artifact"
curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$base/SHA256SUMS" -o "$temp/SHA256SUMS"
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
if [ -x "$target/fork" ]; then
    case "$("$target/fork" version 2>/dev/null || true)" in
        'fork 0.3.'*) "$target/fork" service uninstall >/dev/null 2>&1 || true; "$target/fork" stop >/dev/null 2>&1 || true ;;
        'fork '*) "$target/fork" stop >/dev/null 2>&1 || true ;;
    esac
fi
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
if [ "$virtual_computer" = true ]; then
    curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$base/virtual-computer.tar.gz" -o "$temp/virtual-computer.tar.gz"
    expected=$(awk '$2=="virtual-computer.tar.gz" {print $1}' "$temp/SHA256SUMS")
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temp/virtual-computer.tar.gz" | awk '{print $1}'); else actual=$(shasum -a 256 "$temp/virtual-computer.tar.gz" | awk '{print $1}'); fi
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo 'Virtual computer checksum mismatch.' >&2; exit 1; }
    cli_dir=$("$target/fork" config-dir)
    tar -xzf "$temp/virtual-computer.tar.gz" -C "$cli_dir"
    "$target/fork" virtual-install "$cli_dir/virtual-computer"
fi
if [ -n "$setup_token" ]; then
    if [ "$agent" = claude ] && ! command -v claude >/dev/null 2>&1; then
        echo 'Installing official Claude Code…'
        curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 https://claude.ai/install.sh -o "$temp/claude-install.sh"
        bash "$temp/claude-install.sh"
    fi
    if [ "$agent" = codex ] && ! command -v codex >/dev/null 2>&1; then
        echo 'Installing official Codex CLI…'
        curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 https://chatgpt.com/codex/install.sh -o "$temp/codex-install.sh"
        sh "$temp/codex-install.sh"
    fi
    printf '%s\n' "$setup_token" | "$target/fork" setup --host "$host" --agent "$agent" --virtual-computer "$virtual_computer" --token-stdin
    unset setup_token
else
    echo "Connect using your personal install command in Fork → Subscription."
fi
