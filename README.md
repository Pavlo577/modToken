# token-tracker

A Claude Code mod that records token usage and timing for every turn (session, model, input/output/cache tokens, duration) and sends it to your own Cloudflare Worker, so several devices roll up under one account. The site (sign-in by email, invite only) shows the statistics and creates one-time codes that link devices.

```
device (mod) ──/api/ingest──▶ Worker ──▶ D1
browser ──Cloudflare Access (email PIN)──▶ /admin  (devices, dashboard)
```

## Deploy the backend (once, by the owner)
```bash
cd worker && npm install
npx wrangler d1 create modtoken            # put the printed database_id into wrangler.jsonc
npx wrangler d1 execute modtoken --remote --file=schema.sql
npx wrangler deploy
```
Then protect the admin in Cloudflare Zero Trust → Access → Applications → Self-hosted:
- Application paths: `track.brolafkodev.pp.ua/admin*` and `track.brolafkodev.pp.ua/api/admin*` (**not** `/api/ingest` and `/api/link`: devices authenticate with their own token).
- Login method: One-time PIN. Policy: Allow, Emails = the people you invite (add an email to invite someone).
- Copy the application's **Audience (AUD) tag** and your team domain (`https://<team>.cloudflareaccess.com`) into `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc`, then `npx wrangler deploy` again.

## Use it
1. Install the mod: `/plugin marketplace add Pavlo577/modToken`, then `/plugin install token-tracker@modtoken`.
2. Optional: `/tracker-setup https://<your-site>` if your site is not the default one in `hooks/register.ts`.
3. On the site: Devices → create a code (valid 10 minutes, links one device only).
4. On the device: `/tracker-link <code>`.

The status line shows `token-tracker: ok` after an upload. Failed uploads are queued and retried at the next session start. A device can be revoked on the site at any time.

## Import old history
The mod only counts turns after a device is linked. To bring in earlier history: on the site open Devices → "Import old data", pick the device and the folder `~/.claude/projects` (Windows: `%USERPROFILE%\.claude\projects`). The browser reads the `.jsonl` logs and sends only token counts, timestamps and model names. Only history from before the device was linked is imported, and a repeat import adds nothing twice. Logs on a headless server: copy them first, e.g. `scp -r user@host:~/.claude/projects ./projects`, then pick the copy and the server's device.

Imported turns are grouped by prompt; their duration is the time from the prompt to the last reply, so it includes waiting for approvals and can look longer than live-tracked turns.

## Tests
`npm test` (in `worker/`) checks the log parser, including against real logs in `~/.claude/projects` when present. `worker/test/smoke.sh` runs against `wrangler dev` (put `DEV_EMAIL=me@example.com` in `worker/.dev.vars` first); `smoke.sh --gate` runs against a dev server started without it and checks that the admin API refuses unauthenticated and forged requests.
