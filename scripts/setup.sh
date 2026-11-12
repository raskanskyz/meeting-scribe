#!/bin/bash
# Meeting Scribe - one-command install.
# Installs system dependencies, builds the app, and puts
# "Meeting Scribe.app" in /Applications. Safe to re-run; every step is
# idempotent. Asks for your password once (BlackHole is an audio driver).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Meeting Scribe is macOS-only."

step "Checking build tools"
xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools missing - run: xcode-select --install (then re-run this script)"
ok "Xcode Command Line Tools"

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew missing - install it first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\" (then re-run this script)"
fi
ok "Homebrew"

step "Installing system dependencies"
# macOS 14.2+ taps system audio directly (ScreenCaptureKit) - no audio driver,
# no password, no output switching. Older macOS still needs the BlackHole route.
OS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
OS_MINOR=$(sw_vers -productVersion | cut -d. -f2)
NEEDS_BLACKHOLE=1
if [ "$OS_MAJOR" -gt 14 ] || { [ "$OS_MAJOR" -eq 14 ] && [ "$OS_MINOR" -ge 2 ]; }; then
  NEEDS_BLACKHOLE=0
fi

NEW_BLACKHOLE=0
if [ "$NEEDS_BLACKHOLE" = 0 ]; then
  ok "macOS $(sw_vers -productVersion) captures meeting audio natively - skipping BlackHole"
elif ! ls /Library/Audio/Plug-Ins/HAL/ 2>/dev/null | grep -qi blackhole; then
  brew install --cask blackhole-2ch
  NEW_BLACKHOLE=1
  ok "BlackHole 2ch installed"
else
  ok "BlackHole 2ch already installed"
fi

PKGS="uv node"
[ "$NEEDS_BLACKHOLE" = 1 ] && PKGS="switchaudio-osx $PKGS"
for pkg in $PKGS; do
  if brew list "$pkg" >/dev/null 2>&1 || command -v "${pkg/switchaudio-osx/SwitchAudioSource}" >/dev/null 2>&1; then
    ok "$pkg already installed"
  else
    brew install "$pkg"
    ok "$pkg installed"
  fi
done

if [ "$NEW_BLACKHOLE" = 1 ]; then
  step "Restarting the audio system so BlackHole appears (needs your password)"
  sudo killall coreaudiod || true
  ok "coreaudiod restarted"
fi

step "Building the app"
npm ci
npm run install:app
ok "Meeting Scribe.app installed to /Applications"

step "Done"
echo "  Launching Meeting Scribe - the setup wizard inside the app walks"
echo "  through the rest (model download, speakers, summaries, calendar)."
[ "$NEEDS_BLACKHOLE" = 0 ] && echo "  macOS will ask once to allow system-audio recording - approve it."
open "/Applications/Meeting Scribe.app"
