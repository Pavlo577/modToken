# token-tracker

A Claude Code mod that records token usage and timing for every turn (session, model, input/output/cache tokens, duration) and sends it to a Supabase backend, so several devices roll up under one account. Devices are linked with a one-time code created on the site (sign-in by email); each device keeps its own revocable token.

## Backend setup (once, by the owner)
1. Run `schema.sql` in the Supabase SQL editor.
2. Deploy both functions without JWT checks: `supabase functions deploy ingest --no-verify-jwt` and `supabase functions deploy link --no-verify-jwt`.
3. Enable email sign-in in Supabase Auth.

## Using it
1. Install: `/plugin marketplace add Pavlo577/modToken`, then `/plugin install token-tracker@modtoken`.
2. `/tracker-setup https://<ref>.supabase.co` (once per device).
3. On the site: sign in, Devices → Add device, copy the one-time code (valid 10 minutes).
4. On the device: `/tracker-link <code>`. A code links one device only.

The status line shows `tracker: ok` after an upload. Failed uploads are queued and retried at the next session start.
