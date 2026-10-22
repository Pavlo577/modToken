# token-tracker

A Claude Code mod that records token usage and timing for every turn (device, session, model, input/output/cache tokens, duration) and sends it to a Supabase table, so several devices roll up into one place for a dashboard.

## Setup
1. Run `schema.sql` in the Supabase SQL editor of your project.
2. Install: `/plugin install token-tracker --marketplace Pavlo577/modToken`
3. Run `/tracker-setup https://<ref>.supabase.co <anon-key> <device-name>` (or set `pluginConfigs.token-tracker.options` in `~/.claude/settings.json` by hand).

Failed uploads are queued locally and retried at the next session start; duplicates are ignored.
