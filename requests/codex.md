## Make the Stop hook the only default setup path
Status: open
Needs: collectors/token-tracker.mjs (`setup()` output) and shared setup documentation/tests
What: Present installation of `hooks.json` Stop hook as the default automatic-update setup. Keep `notify` supported, but show it only as an explicit fallback for older Codex versions or installations where the Stop hook is unavailable or declined. Never install both by default.
Why: The interactive wizard already installs only the Stop hook first and offers notify only when the hook is not active, but the non-interactive `setup` command still instructs users to add `notify` as its primary step 3.
Patch: Change `setup()` to print the Stop-hook command/configuration first. Move the current `config.toml notify` instructions under a clearly labelled fallback section. Add a shared test asserting that the default setup output leads with `hook-stop`/`hooks.json` and labels notify as fallback.
Blocks: consistent default setup behavior across interactive and script-oriented flows

## Make shared subprocess tests portable to Windows
Status: done
Needs: worker/test/shared.test.mjs
What: Build dynamic-import specifiers for spawned `node -e` scripts with `pathToFileURL(...).href` instead of replacing backslashes with slashes.
Why: On Windows, `import('C:/...')` is rejected as an unsupported URL scheme. The HTTP-timeout child prints nothing and all rotation writers exit before logging, so the official `npm test` fails even though the underlying shared behavior is not exercised.
Patch: Import `pathToFileURL` from `node:url`; precompute file URLs for `collectors/lib/core.mjs` and `collectors/lib/notify-log.mjs`, then interpolate their JSON-encoded `.href` values into the child scripts.
Blocks: a green official Node test suite on Windows

## Do not log downstream notify argument values
Status: done
Needs: collectors/token-tracker.mjs, worker/test/notify.test.mjs
What: Replace the `arguments` array in `downstream_started` with service-only metadata such as `argumentCount` and `hasJsonPayload`. Never log downstream argument values, including plain strings.
Why: A command such as `other-notifier.exe --token SECRET` currently writes the secret to `notify.log`, contrary to the service-fields-only privacy rule.
Patch: Remove `safeArg` and log `{ event, program, argumentCount: then.length - 1, hasJsonPayload: Boolean(payload) }`; add a regression test with a secret in a non-JSON `--then` argument.
Blocks: privacy guarantee for chained notify commands

## Add HTTP timeouts and a live-process-aware sync lock
Status: done
Needs: collectors/lib/core.mjs and its tests
What: Give `link()` and `post()` a bounded timeout (for example `AbortSignal.timeout(30_000)`) with a stable, path-free error. Store enough lock metadata to avoid taking over a still-live sync merely because its lock is five minutes old.
Why: A stalled request can keep the first sync alive while the age-only lock permits a second sync to start concurrently.
Patch: Use an abort signal for both fetch calls; store PID and start time in the lock and verify process liveness where the platform permits it.
Blocks: nothing, carrying on

## Sanitize shared diagnostic errors
Status: done
Needs: collectors/token-tracker.mjs, collectors/lib/notify-log.mjs
What: Map sync/spawn failures to a small allow-list of service error codes instead of logging raw `e.message` values.
Why: Filesystem and process errors may contain local paths, which diagnostic logs must not retain.
Patch: Log stable categories such as `timeout`, `network`, `http`, `spawn`, and `unknown`; keep detailed messages only on stderr for an explicit foreground command if they contain no sensitive path.
Blocks: complete privacy guarantee for error paths

## Make notify log rotation safe under concurrent writers
Status: done
Needs: collectors/lib/notify-log.mjs
What: Serialize rotation and append operations or use an atomic rotation strategy that cannot truncate another hook/notify process's write.
Why: `hook-stop` and `notify` may run concurrently and currently can race while rotating the same log.
Patch: Use a short-lived exclusive rotation lock and atomic rename, while keeping append-only writes independent.
Blocks: nothing, carrying on

## Run validation before collector releases
Status: done
Needs: .github/workflows/collector-release.yml
What: Run the official Node and Bun tests plus typecheck before compiling and publishing collector binaries.
Why: The release workflow currently executes only a compiled `status` smoke check, so a tested regression can still be published.
Patch: Add `npm test`, `bun test`, and `bun run typecheck` before the build matrix or as a required preceding job.
Blocks: release confidence, not local development

## Correct the wizard privacy wording
Status: done
Needs: collectors/wizard.mjs
What: Say that conversation text is not collected, stored, or sent, rather than saying it is not read.
Why: The streaming parser must JSON-parse complete rollout lines in memory even though it discards all text fields.
Patch: Use Ukrainian wording equivalent to: "Тексти розмов не збираються, не зберігаються і не надсилаються."
Blocks: nothing, carrying on
