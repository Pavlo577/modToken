#!/bin/bash
# Token Tracker, cloud session (claude.ai/code): installs the token-tracker mod (mods/token-tracker), which sends the subscription rate limits. Nothing secret here.
# Paste into "Setup script":  curl -fsSL <raw url of this file> | bash
# A setup script cannot read the environment's saved variables, so the OTLP settings, the token and CLAUDE_CODE_PLUGIN_DIRS (which loads this mod)
# go into "Environment variables" (the dashboard's "Add device" box, step 3); the mod finds the site and the token in the OTLP variables.
# Every step is written to ~/.claude/token-tracker-setup.log, so a new session can tell why something is missing.
mkdir -p "$HOME/.claude"
LOG="$HOME/.claude/token-tracker-setup.log"
say() { echo "Token Tracker: $*"; echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
say "start: user=$(id -un) home=$HOME"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker}"
# token-tracker is the mod; otlp-check is diagnostics (compares its token counts with OTLP's), loaded only when its folder is in CLAUDE_CODE_PLUGIN_DIRS too
for name in token-tracker otlp-check; do
  MOD="$HOME/.claude/mods/$name"
  mkdir -p "$MOD/.claude-plugin" "$MOD/hooks"
  ok=1
  for f in .claude-plugin/plugin.json hooks/hooks.json hooks/register.ts; do
    curl -fsSL --max-time 20 "$RAW/mods/$name/$f" -o "$MOD/$f" || { ok=0; break; }
  done
  if [ $ok = 1 ]; then say "mod $name installed in $MOD"; else rm -rf "$MOD"; say "mod $name not downloaded"; fi
done
say "loaded when CLAUDE_CODE_PLUGIN_DIRS names the folders, separated by ':' ($HOME/.claude/mods/token-tracker:$HOME/.claude/mods/otlp-check)"
exit 0
