#!/bin/bash
# Token Tracker, cloud session (claude.ai/code): installs the mod (mods/limits-probe) that reads the subscription's rate limits. Nothing secret here.
# Paste into "Setup script":  curl -fsSL <raw url of this file> | bash
# A setup script cannot read the environment's saved variables, so the OTLP settings, the token and CLAUDE_CODE_PLUGIN_DIRS (which loads this mod)
# go into "Environment variables" (the dashboard's "Add device" box, step 3); the mod finds the site and the token in the OTLP variables.
# Every step is written to ~/.claude/token-tracker-setup.log, so a new session can tell why something is missing.
mkdir -p "$HOME/.claude"
LOG="$HOME/.claude/token-tracker-setup.log"
say() { echo "Token Tracker: $*"; echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
say "start: user=$(id -un) home=$HOME"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker}"
MOD="$HOME/.claude/mods/limits-probe"
mkdir -p "$MOD/.claude-plugin" "$MOD/hooks"
for f in .claude-plugin/plugin.json hooks/hooks.json hooks/register.ts; do
  curl -fsSL --max-time 20 "$RAW/mods/limits-probe/$f" -o "$MOD/$f" || { rm -rf "$MOD"; say "mod not downloaded ($f)"; exit 0; }
done
say "mod installed in $MOD (loaded when CLAUDE_CODE_PLUGIN_DIRS=$MOD)"
exit 0
