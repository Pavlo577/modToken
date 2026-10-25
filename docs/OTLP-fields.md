# OTLP fields (generated)

Generated from `worker/src/otlp-fields.ts` by `bun run fields`; do not edit by hand. To record a newly seen field, add it to that file and run the command.

**Handling**: `counted` read for the token/cost counting (and kept with the event); `column` a column of the events table; `stored` kept in the event attributes (numbers, flags and identifier-like words only); `identity` never kept (who the user or the machine is); `content` never kept (may hold the text of the conversation; the Claude app sends `<REDACTED>`). Marked "documented only" when no real payload has carried the field yet.

## On every event
| field | type | meaning | handling |
|---|---|---|---|
| `event.name` | string | the kind of event (sometimes with the prefix `claude_code.`) | column |
| `event.sequence` | int | counter inside one process; orders the events and, with the time, identifies one | stored |
| `event.timestamp` | string | ISO time of the event (the record also has timeUnixNano, which is used first) | column |
| `session.id` | id | the session | column |
| `prompt.id` | id | ties all events of one user prompt together (absent on start-up events) | column |
| `terminal.type` | string | the surface: non-interactive (Claude app), ssh-session, pycharm, linux (cloud) ... | column |
| `ccr.session.id` | id | the cloud session id (cse_...) *(only: cloud sessions)* | stored |
| `service.name` | string | the program: claude-code, claude-code-desktop (a resource attribute; in the Claude app also on the record) | column |
| `service.version` | string | version of the program *(only: Claude app)* | stored |
| `claude.deployment_mode` | string | how Claude runs (1p = first party) *(only: Claude app)* | stored |
| `os.type` | string | operating system *(only: Claude app)* | stored |
| `os.version` | string | operating system version *(only: Claude app)* | stored |
| `host.arch` | string | CPU architecture *(only: Claude app)* | stored |
| `process.owner` | string | the OS user name of the person running the program *(only: Claude app)* | identity |
| `user.email` | string | the account email | identity |
| `user.account_id` | id | the account id as the admin API knows it | identity |
| `user.account_uuid` | id | the account uuid | identity |
| `user.id` | id | anonymous id of this installation (differs per machine) | identity |
| `organization.id` | id | the organization uuid | identity |

## `api_refusal`
| field | type | meaning | handling |
|---|---|---|---|
| `model` | string | model id | counted |
| `speed` | string | normal or fast | stored |
| `effort` | string | thinking effort setting (medium ...) | stored |
| `request_id` | id | the API request id; the call id of the counting (a call is counted once) | counted |
| `query_source` | string | who asked: repl_main_thread (you), sdk (app / cloud), generate_session_title, away_summary ... | stored |
| `attempt` | int | which attempt was refused | stored |
| `has_category` | bool | the refusal names a category | stored |
| `has_explanation` | bool | the refusal carries an explanation | stored |
| `server_fallback_hop` | int | how many hops to a fallback model happened | stored |

## `api_request`
| field | type | meaning | handling |
|---|---|---|---|
| `input_tokens` | int | new input of the call, cache excluded | counted |
| `output_tokens` | int | what the model wrote | counted |
| `cache_read_tokens` | int | input served from the cache | counted |
| `cache_creation_tokens` | int | input written to the cache (1h + 5m) | counted |
| `cache_creation_1h_tokens` | int | part of the cache writes with a one-hour life | stored |
| `cache_creation_5m_tokens` | int | part of the cache writes with a five-minute life | stored |
| `duration_ms` | int | how long the call / tool / connection took | counted |
| `ttft_ms` | int | time to the first token | stored |
| `model` | string | model id | counted |
| `speed` | string | normal or fast | stored |
| `effort` | string | thinking effort setting (medium ...) | stored |
| `cost_usd` | float | Claude Code's own price estimate of the call in dollars | counted |
| `cost_usd_micros` | int | the same in millionths of a dollar | counted |
| `request_id` | id | the API request id; the call id of the counting (a call is counted once) | counted |
| `client_request_id` | id | client-side id of the request | stored |
| `query_source` | string | who asked: repl_main_thread (you), sdk (app / cloud), generate_session_title, away_summary ... | stored |
| `agent_id` | id | set on sub-agent calls only; makes the call a sub-agent call *(documented only)* | counted |
| `parent_agent_id` | id | the agent that started a sub-agent *(documented only)* | stored |

## `assistant_response`
| field | type | meaning | handling |
|---|---|---|---|
| `model` | string | model id | counted |
| `request_id` | id | the API request id; the call id of the counting (a call is counted once) | counted |
| `query_source` | string | who asked: repl_main_thread (you), sdk (app / cloud), generate_session_title, away_summary ... | stored |
| `message.uuid` | id | id of the message | stored |
| `response` | string | the text of the answer (arrives as <REDACTED>) | content |
| `response_length` | int | length of the answer in characters | stored |

## `hook_execution_complete`
| field | type | meaning | handling |
|---|---|---|---|
| `hook_event` | string | the event the hook is for (Stop ...) | stored |
| `hook_name` | string | the hook | stored |
| `hook_source` | string | where it is defined (merged, settings ...) | stored |
| `num_hooks` | int | hooks for this event | stored |
| `managed_only` | bool | only managed hooks are allowed | stored |
| `safe_mode` | bool | safe mode is on | stored |
| `num_success` | int | hooks that succeeded | stored |
| `num_blocking` | int | hooks that blocked | stored |
| `num_cancelled` | int | hooks that were cancelled | stored |
| `num_non_blocking_error` | int | hooks that failed without blocking | stored |
| `num_outputs_persisted` | int | hook outputs kept | stored |
| `total_duration_ms` | int | how long the hooks took | stored |
| `stdout_chars` | int | length of the hooks output | stored |
| `system_message_chars` | int | length of the system message the hooks added | stored |
| `additional_context_chars` | int | length of the context the hooks added | stored |
| `initial_user_message_chars` | int | length of the first message the hooks added | stored |

## `hook_execution_start`
| field | type | meaning | handling |
|---|---|---|---|
| `hook_event` | string | the event the hook is for (Stop ...) | stored |
| `hook_name` | string | the hook | stored |
| `hook_source` | string | where it is defined (merged, settings ...) | stored |
| `num_hooks` | int | hooks for this event | stored |
| `managed_only` | bool | only managed hooks are allowed | stored |
| `safe_mode` | bool | safe mode is on | stored |

## `hook_registered`
| field | type | meaning | handling |
|---|---|---|---|
| `hook_event` | string | the event the hook is for (Stop ...) | stored |
| `hook_source` | string | where it is defined (merged, settings ...) | stored |
| `hook_type` | string | command, prompt ... | stored |
| `safe_mode` | bool | safe mode is on | stored |

## `managed_settings_resolved`
| field | type | meaning | handling |
|---|---|---|---|
| `managed_settings.helper.applied` | string | was a settings helper applied | stored |
| `managed_settings.helper.state` | string | state of the helper | stored |
| `managed_settings.source_behavior` | string | which settings source wins (first-wins ...) | stored |
| `managed_settings.trigger` | string | what caused the read (startup ...) | stored |

## `mcp_server_connection`
| field | type | meaning | handling |
|---|---|---|---|
| `duration_ms` | int | how long the call / tool / connection took | counted |
| `plugin.name` | string | the plugin | stored |
| `plugin_id_hash` | id | hash of the plugin id | stored |
| `status` | string | connected or failed | stored |
| `error_code` | string | why a connection failed (ENDPOINT_NOT_FOUND ...) | stored |
| `transport_type` | string | http, ws-ide, claudeai-proxy ... | stored |
| `server_scope` | string | dynamic, claudeai ... | stored |
| `is_plugin` | bool | the server comes from a plugin | stored |

## `permission_mode_changed`
| field | type | meaning | handling |
|---|---|---|---|
| `from_mode` | string | the permission mode before | stored |
| `to_mode` | string | the permission mode after | stored |

## `plugin_loaded`
| field | type | meaning | handling |
|---|---|---|---|
| `safe_mode` | bool | safe mode is on | stored |
| `plugin.name` | string | the plugin | stored |
| `plugin_id_hash` | id | hash of the plugin id | stored |
| `plugin.scope` | string | where the plugin is installed (user-local ...) | stored |
| `marketplace.name` | string | the marketplace it came from | stored |
| `enabled_via` | string | how it was enabled (user-install ...) | stored |
| `has_hooks` | bool | the plugin has hooks | stored |
| `has_mcp` | bool | the plugin has an MCP server | stored |
| `host_owned_mcp` | bool | the MCP server belongs to the host | stored |
| `agent_path_count` | int | agents in the plugin | stored |
| `command_path_count` | int | commands in the plugin | stored |
| `skill_path_count` | int | skills in the plugin | stored |

## `retention_sweep`
| field | type | meaning | handling |
|---|---|---|---|
| `artifacts_deleted` | int | old artifacts removed | stored |
| `transcripts_deleted` | int | old transcripts removed | stored |
| `session_files_deleted` | int | old session files removed | stored |
| `files_past_cutoff` | int | files older than the cutoff | stored |
| `files_retained_fresh` | int | files kept because they are fresh | stored |
| `history_entries_pruned` | int | history entries removed | stored |
| `error_count` | int | errors during the sweep | stored |
| `period_days` | int | retention period | stored |
| `result` | string | complete ... | stored |
| `used_default` | bool | the default period was used | stored |
| `transcripts_exempted_desktop` | int | transcripts the Claude app kept | stored |

## `safety_event`
| field | type | meaning | handling |
|---|---|---|---|
| `tool_name` | string | the tool (Bash, Read, Edit, PowerShell ...) | stored |
| `tool_source` | string | where the tool comes from (builtin ...) | stored |
| `tool_use_id` | id | id of one use of a tool | stored |
| `decision` | string | accept or reject | stored |
| `permission_mode` | string | the permission mode (default, auto ...) | stored |
| `decision_source` | string | who allowed the run | stored |
| `category` | string | kind of safety check | stored |
| `reason_code` | string | why it stopped or allowed (workingDir ...) | stored |
| `reason_type` | string | kind of reason | stored |
| `tool_class` | string | file, shell ... | stored |
| `sandbox_enabled` | bool | the sandbox was on | stored |
| `sandbox_violation_count` | int | sandbox violations | stored |

## `tool_decision`
| field | type | meaning | handling |
|---|---|---|---|
| `request_id` | id | the API request id; the call id of the counting (a call is counted once) | counted |
| `tool_name` | string | the tool (Bash, Read, Edit, PowerShell ...) | stored |
| `tool_source` | string | where the tool comes from (builtin ...) | stored |
| `tool_use_id` | id | id of one use of a tool | stored |
| `decision` | string | accept or reject | stored |
| `source` | string | who decided: config, user_reject ... | stored |
| `permission_mode` | string | the permission mode (default, auto ...) | stored |
| `classifier_verdict` | string | what the safety classifier said (allow ...) | stored |

## `tool_result`
| field | type | meaning | handling |
|---|---|---|---|
| `duration_ms` | int | how long the call / tool / connection took | counted |
| `request_id` | id | the API request id; the call id of the counting (a call is counted once) | counted |
| `tool_name` | string | the tool (Bash, Read, Edit, PowerShell ...) | stored |
| `tool_use_id` | id | id of one use of a tool | stored |
| `success` | bool | the tool finished without an error | stored |
| `tool_input_size_bytes` | int | size of the tool input (not its content) | stored |
| `tool_result_size_bytes` | int | size of the tool result (not its content) | stored |
| `decision_source` | string | who allowed the run | stored |
| `decision_type` | string | accept or reject | stored |

## `user_prompt`
| field | type | meaning | handling |
|---|---|---|---|
| `prompt` | string | the text of the message (arrives as <REDACTED>) | content |
| `prompt_text` | string | the text of the message again (arrives as <REDACTED>) | content |
| `prompt_length` | int | length of the message in characters | stored |
| `message.uuid` | id | id of the message | stored |
| `command_name` | string | the slash command, when the message was one (ide ...) | stored |
| `command_source` | string | where the command comes from (builtin ...) | stored |

## Totals

117 fields: 10 counted, 6 columns, 92 stored, 6 identity (never kept), 3 content (never kept).
