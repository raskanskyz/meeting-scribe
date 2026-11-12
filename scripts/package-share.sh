#!/bin/bash
# Build a shareable installer zip: unsigned DMG + INSTALL.txt, no Apple
# Developer account and no notarization. Receivers clear the quarantine
# flag once - INSTALL.txt walks them (or their AI agent) through it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

VERSION=$(node -p "require('./package.json').version")
OUT="dist.noindex"
SHARE="$OUT/share/meeting-scribe-install"

# sidecars rebuild only when their source changed, so a healthy binary from a
# previous build still packages when the Swift toolchain is unavailable
[ swift/calendar-sidecar -nt swift/calendar.swift ] || npm run build:calendar
[ swift/audio-sidecar -nt swift/audio.swift ] || npm run build:audio
[ swift/audiosetup-sidecar -nt swift/audiosetup.swift ] || npm run build:audiosetup
[ swift/ocr-sidecar -nt swift/ocr.swift ] || npm run build:ocr
[ swift/diarize-sidecar -nt swift/diarize/main.swift ] || npm run build:diarize
npx electron-vite build
# identity=null skips code signing entirely: the binaries keep their ad-hoc
# (linker) signature, which runs on any Apple Silicon Mac once the receiver
# removes the quarantine flag. Signing would demand a Developer ID cert.
NODE_OPTIONS=--experimental-require-module CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac dmg -c.mac.identity=null

DMG_PATH=$(ls -t "$OUT"/*.dmg | head -1)
DMG=$(basename "$DMG_PATH")

rm -rf "$OUT/share"
mkdir -p "$SHARE"
cp "$DMG_PATH" "$SHARE/"

cat > "$SHARE/INSTALL.txt" <<EOF
Meeting Scribe ${VERSION} - install instructions (macOS, Apple Silicon)
=======================================================================

What this is
------------
A local meeting recorder + transcriber. It records two tracks - your mic
("Me") and the meeting's system audio (everyone else) - transcribes on your
Mac (Hebrew via ivrit.ai Whisper fine-tunes, English and more via Whisper),
identifies who said what by voice, and writes an AI summary with action
items. Everything runs locally: recordings and transcripts never leave your
machine. Summaries optionally run through your own Claude Code subscription;
offline mode disables all network use.

REQUIREMENTS
------------
- Apple Silicon Mac (M1–M4). This build is arm64-only - it will NOT run on
  an Intel Mac.
- macOS 14.2 or newer: meeting audio is captured with a direct system-audio
  tap, no driver needed. On older macOS you must additionally install the
  BlackHole audio driver (brew install --cask blackhole-2ch) and pick
  "BlackHole virtual device" under Settings → Meeting audio capture.
- uv (the Python runner) - transcription runs through it:

      brew install uv

  (no Homebrew? curl -LsSf https://astral.sh/uv/install.sh | sh)
- Optional, for AI summaries and transcript polish: the Claude Code CLI,
  signed in to your subscription. No API key involved.

Install (three steps in order - do not launch before step 3)
------------------------------------------------------------
1. Open ${DMG} and drag "Meeting Scribe" into Applications.

2. Do NOT open the app yet.

3. In Terminal, run:

       xattr -dr com.apple.quarantine "/Applications/Meeting Scribe.app"

   Why: the app is not notarized with Apple (no Developer ID cert). Because
   the dmg reached you via a download/AirDrop/Slack, macOS marks it
   quarantined and will refuse to launch it - often silently, or with only
   a "Move to Trash" option. The command removes the quarantine mark; after
   that it launches normally, forever. One-time step.

4. Now launch "Meeting Scribe" from Applications (or Spotlight).

If you already tried opening it and got stuck (e.g. it only offers to
delete the app): the quarantine mark gets locked once a quarantined copy is
launched, and xattr then fails with "Operation not permitted". Recovery:
delete the app from Applications, drag a fresh copy from the dmg, run the
xattr command, and ONLY THEN launch it.

macOS permissions - what the app asks for and why
-------------------------------------------------
1. Microphone - prompted the first time you record. Click Allow.
2. Screen & System Audio Recording - powers the meeting-audio tap (what
   the other participants say) and the optional screen recording. macOS
   prompts on your first recording; approve "Meeting Scribe" under System
   Settings → Privacy & Security → Screen & System Audio Recording.
   Without it you still get your mic track, just no meeting audio.
3. Calendar (optional) - prefills meeting title + invitees and enables
   meeting reminders. Skip if you don't care.
4. Notifications (optional) - the meeting-starting-soon reminder.

Because the build is unsigned, installing a NEWER build over this one may
re-prompt some permissions - that's normal, approve again.

First launch
------------
A setup wizard walks you through the rest:
- picking + downloading a transcription model (a few GB, one-time)
- a meeting-audio capture check
- speaker identification - needs a free Hugging Face account + token; the
  wizard links you through it
- Claude summaries and calendar access

The first transcription also builds the Python environment via uv
(one-time, a few minutes, needs network).

Run / quit
----------
Menu-bar (tray) app. Closing the window keeps it recording/monitoring from
the tray. ⌘R starts/stops recording. To actually quit: tray icon → Quit.

If something looks wrong
------------------------
- App bounces once in the Dock and disappears, or only offers "Move to
  Trash": you skipped step 3, or launched before running it. See the
  recovery steps above. On an Intel Mac it will never launch.
- Transcription fails immediately: uv is missing - brew install uv, retry.
- Meeting track is silent: your Mac's sound output was muted during the
  recording (the tap reads post-volume audio - keep some volume), or the
  Screen & System Audio Recording permission wasn't granted.
- No AI summary button: install the Claude Code CLI and sign in, or set
  its path in Settings.

For Claude Code / an AI agent doing this install on the teammate's behalf
--------------------------------------------------------------------------
Run exactly, in order, waiting for each to finish before the next:

    hdiutil attach "${DMG}" -nobrowse -mountpoint /tmp/mscribe-mount
    rm -rf "/Applications/Meeting Scribe.app"
    cp -R "/tmp/mscribe-mount/Meeting Scribe.app" "/Applications/Meeting Scribe.app"
    hdiutil detach /tmp/mscribe-mount
    xattr -dr com.apple.quarantine "/Applications/Meeting Scribe.app"
    command -v uv >/dev/null 2>&1 || brew install uv
    open "/Applications/Meeting Scribe.app"

Do not open the app between the cp and the xattr command - that locks the
quarantine flag and forces a full delete + re-copy to recover.

Everything after launch (model download, Hugging Face token, permissions)
happens in the app's own setup wizard - tell the human to follow it rather
than pre-configuring files by hand.
EOF

(cd "$OUT/share" && rm -f meeting-scribe-mac-install.zip && zip -qr meeting-scribe-mac-install.zip meeting-scribe-install)

echo
echo "Share this file: $REPO_DIR/$OUT/share/meeting-scribe-mac-install.zip"
