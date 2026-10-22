# token-tracker

A Claude Code mod that records token usage and timing for every turn (session, model, input/output/cache tokens, duration) and sends it to your Supabase project through an Edge Function, so several devices roll up into one place for a dashboard. Each device has its own revocable token; the database tables are closed to direct access.

## Setup
1. Run `schema.sql` in the Supabase SQL editor.
2. Deploy the function: `supabase functions deploy ingest --no-verify-jwt` (code in `supabase/functions/ingest`).
3. Create a token per device: `select create_device('linux-home');` and copy it (shown once). Revoke with `update devices set revoked = true where name = '...'`.
4. Install the mod: `/plugin marketplace add Pavlo577/modToken`, then `/plugin install token-tracker@modtoken`.
5. Run `/tracker-setup https://<ref>.supabase.co`, and set `deviceToken` (install screen, or `pluginConfigs.token-tracker.options.deviceToken` in `~/.claude/settings.json`).

The status line shows `tracker: ok` after a successful upload. Failed uploads are queued and retried at the next session start.
