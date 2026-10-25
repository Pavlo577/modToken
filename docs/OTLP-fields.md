# What Claude Code sends over OTLP (observed)

Observed on four surfaces with real sessions (Oct 2026): the Claude app (`terminal.type: non-interactive`, `service.name: claude-code-desktop`), an SSH session (`ssh-session`), the JetBrains plugin (`pycharm`) and a cloud session (`linux`, with `ccr.session.id`). Values are shown as they arrive; prompt and answer text arrive as `<REDACTED>` (only the lengths are real). Names marked *(inferred)* are my reading of the name, not documented.

## Fields on every event
| field | meaning |
|---|---|
| `event.name` | the kind of event (sometimes with the prefix `claude_code.`) |
| `event.sequence` | counter inside one process, orders the events |
| `event.timestamp` | ISO time of the event (the record also has `timeUnixNano`) |
| `session.id` | the session |
| `prompt.id` | ties all events of one user prompt together (absent on start-up events) |
| `terminal.type` | the surface: `non-interactive` (Claude app), `ssh-session`, `pycharm`, `linux` (cloud) |
| `ccr.session.id` | cloud sessions only: the cloud session id (`cse_...`) |
| `user.email`, `user.account_id`, `user.account_uuid`, `organization.id` | who the account is (cannot be switched off) |
| `user.id` | anonymous id of the installation (differs per machine / install) |
| `service.name`, `service.version`, `claude.deployment_mode`, `os.type`, `os.version`, `host.arch`, `process.owner` | the Claude app only: the program, the OS, the CPU and the **OS user name** |

## `api_request` — one call to the model (the only event we count)
| field | meaning | kept |
|---|---|---|
| `input_tokens` | new input, cache excluded | yes |
| `output_tokens` | what the model wrote | yes |
| `cache_read_tokens` | input served from cache | yes |
| `cache_creation_tokens` | input written to cache (`_1h_` / `_5m_` split in `cache_creation_1h_tokens`, `cache_creation_5m_tokens`) | total only |
| `duration_ms`, `ttft_ms` | whole call, time to the first token | duration only |
| `model`, `speed`, `effort` | model id, `normal`/`fast`, `medium`... | model only |
| `cost_usd`, `cost_usd_micros` | Claude Code's own price estimate of the call (matches our `prices.json` result) | no |
| `request_id`, `client_request_id` | API request id (our call id) / client-side id | request id |
| `query_source` | who asked: `repl_main_thread` (you), `sdk` (app/cloud), `generate_session_title`, `away_summary` | no |
| `agent_id`, `parent_agent_id` | only on sub-agent calls | flag only |

## Other events (counted by name only; nothing is stored)
| event | fields | what it tells |
|---|---|---|
| `user_prompt` | `prompt`, `prompt_text` (`<REDACTED>`), `prompt_length`, `message.uuid`, `command_name`, `command_source` | you sent a message or a slash command |
| `assistant_response` | `response` (`<REDACTED>`), `response_length`, `message.uuid`, `model`, `request_id`, `query_source` | the model answered |
| `api_refusal` | `attempt`, `has_category`, `has_explanation`, `server_fallback_hop`, `model`, `request_id`, `speed`, `effort`, `query_source` | the model refused, possibly falling back to another model *(inferred)* |
| `tool_decision` | `tool_name`, `tool_source`, `tool_use_id`, `decision`, `source`, `permission_mode`, `classifier_verdict`, `request_id` | a tool use was accepted or rejected |
| `tool_result` | `tool_name`, `tool_use_id`, `success`, `duration_ms`, `tool_input_size_bytes`, `tool_result_size_bytes`, `decision_source`, `decision_type` | a tool ran (sizes only, no content) |
| `safety_event` | `category`, `decision`, `decision_source`, `reason_code`, `reason_type`, `tool_class`, `tool_name`, `tool_source`, `tool_use_id`, `permission_mode`, `sandbox_enabled`, `sandbox_violation_count` | a safety check stopped or allowed something |
| `permission_mode_changed` | `from_mode`, `to_mode` | e.g. `default` to `auto` |
| `hook_registered` | `hook_event`, `hook_source`, `hook_type` | a hook was found at start |
| `hook_execution_start` / `_complete` | `hook_event`, `hook_name`, `hook_source`, `num_hooks`, `managed_only`, `safe_mode`; complete adds `num_success`, `num_blocking`, `num_cancelled`, `num_non_blocking_error`, `num_outputs_persisted`, `total_duration_ms`, `stdout_chars`, `system_message_chars`, `additional_context_chars`, `initial_user_message_chars` | hooks ran (e.g. `Stop`) |
| `plugin_loaded` | `plugin.name`, `plugin_id_hash`, `plugin.scope`, `marketplace.name`, `enabled_via`, `has_hooks`, `has_mcp`, `host_owned_mcp`, `agent_path_count`, `command_path_count`, `skill_path_count`, `safe_mode` | a plugin was loaded at start |
| `mcp_server_connection` | `status`, `error_code`, `duration_ms`, `transport_type`, `server_scope`, `is_plugin`, `plugin.name`, `plugin_id_hash` | an MCP server connected or failed |
| `managed_settings_resolved` | `managed_settings.helper.applied`, `.helper.state`, `.source_behavior`, `.trigger` | start-up: managed settings read |
| `retention_sweep` | `artifacts_deleted`, `transcripts_deleted`, `session_files_deleted`, `files_past_cutoff`, `files_retained_fresh`, `history_entries_pruned`, `error_count`, `period_days`, `result`, `used_default`, `transcripts_exempted_desktop` | housekeeping of old local files |

## What the Worker keeps from all of it
From `api_request` only: the event time, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `duration_ms`, `model`, `request_id` (call id), `session.id`, `prompt.id` (turn key), `agent_id` present (sub-agent flag), provider `claude`. Everything else is dropped on arrival; the other events only leave a count and the attribute names in `otlp_seen` (and, in the preview debug mode, one sample).
