// The registry of every field an agent sends over OTLP, and what the Worker does with it. The ONE place to add a newly seen field:
// docs/OTLP-fields.md is generated from this file (`bun run fields`), test/fields.test.mjs checks that each `handling` is what the code really does,
// and the Insights tab lists the fields that arrive but are not here yet.

/**
 * What happens to a field:
 * - counted:  read for the token / cost counting (and also kept with the event)
 * - column:   kept as a column of the events table
 * - stored:   kept in the events table's attributes (harmless values only: numbers, flags, identifier-like words)
 * - identity: never kept, it says who the user is or what machine it is
 * - content:  never kept, it may hold the text of the conversation (arrives as `<REDACTED>` from the Claude app)
 */
export type Handling = 'counted' | 'column' | 'stored' | 'identity' | 'content'

export interface Field {
  key: string
  /** Events that carry it; '*' = every event. */
  events: string[]
  type: 'string' | 'int' | 'float' | 'bool' | 'id'
  what: string
  handling: Handling
  /** False for fields the documentation names but no real payload has shown yet. */
  seen: boolean
  /** Only on some surfaces / services, when it is. */
  only?: string
}

const ALL = ['*']
const f = (key: string, events: string[], type: Field['type'], what: string, handling: Handling, extra: Partial<Pick<Field, 'seen' | 'only'>> = {}): Field => ({ key, events, type, what, handling, seen: true, ...extra })

export const FIELDS: Field[] = [
  // ---- on every event
  f('event.name', ALL, 'string', 'the kind of event (sometimes with the prefix `claude_code.`)', 'column'),
  f('event.sequence', ALL, 'int', 'counter inside one process; orders the events and, with the time, identifies one', 'stored'),
  f('event.timestamp', ALL, 'string', 'ISO time of the event (the record also has timeUnixNano, which is used first)', 'column'),
  f('session.id', ALL, 'id', 'the session', 'column'),
  f('prompt.id', ALL, 'id', 'ties all events of one user prompt together (absent on start-up events)', 'column'),
  f('terminal.type', ALL, 'string', 'the surface: non-interactive (Claude app), ssh-session, pycharm, linux (cloud) ...', 'column'),
  f('ccr.session.id', ALL, 'id', 'the cloud session id (cse_...)', 'stored', { only: 'cloud sessions' }),
  f('service.name', ALL, 'string', 'the program: claude-code, claude-code-desktop (a resource attribute; in the Claude app also on the record)', 'column'),
  f('service.version', ALL, 'string', 'version of the program', 'stored', { only: 'Claude app' }),
  f('claude.deployment_mode', ALL, 'string', 'how Claude runs (1p = first party)', 'stored', { only: 'Claude app' }),
  f('os.type', ALL, 'string', 'operating system', 'stored', { only: 'Claude app' }),
  f('os.version', ALL, 'string', 'operating system version', 'stored', { only: 'Claude app' }),
  f('host.arch', ALL, 'string', 'CPU architecture', 'stored', { only: 'Claude app' }),
  f('process.owner', ALL, 'string', 'the OS user name of the person running the program', 'identity', { only: 'Claude app' }),
  f('user.email', ALL, 'string', 'the account email', 'identity'),
  f('user.account_id', ALL, 'id', 'the account id as the admin API knows it', 'identity'),
  f('user.account_uuid', ALL, 'id', 'the account uuid', 'identity'),
  f('user.id', ALL, 'id', 'anonymous id of this installation (differs per machine)', 'identity'),
  f('organization.id', ALL, 'id', 'the organization uuid', 'identity'),

  // ---- api_request: one call to the model
  f('input_tokens', ['api_request'], 'int', 'new input of the call, cache excluded', 'counted'),
  f('output_tokens', ['api_request'], 'int', 'what the model wrote', 'counted'),
  f('cache_read_tokens', ['api_request'], 'int', 'input served from the cache', 'counted'),
  f('cache_creation_tokens', ['api_request'], 'int', 'input written to the cache (1h + 5m)', 'counted'),
  f('cache_creation_1h_tokens', ['api_request'], 'int', 'part of the cache writes with a one-hour life', 'stored'),
  f('cache_creation_5m_tokens', ['api_request'], 'int', 'part of the cache writes with a five-minute life', 'stored'),
  f('duration_ms', ['api_request', 'tool_result', 'mcp_server_connection', 'compaction', 'subagent_completed'], 'int', 'how long the call / tool / connection took', 'counted'),
  f('ttft_ms', ['api_request'], 'int', 'time to the first token', 'stored'),
  f('model', ['api_request', 'assistant_response', 'api_refusal', 'subagent_completed', 'api_error', 'api_retries_exhausted'], 'string', 'model id', 'counted'),
  f('speed', ['api_request', 'api_refusal', 'api_error', 'api_retries_exhausted'], 'string', 'normal or fast', 'stored'),
  f('effort', ['api_request', 'api_refusal'], 'string', 'thinking effort setting (medium ...)', 'stored'),
  f('cost_usd', ['api_request'], 'float', "Claude Code's own price estimate of the call in dollars", 'counted'),
  f('cost_usd_micros', ['api_request'], 'int', 'the same in millionths of a dollar', 'counted'),
  f('request_id', ['api_request', 'assistant_response', 'api_refusal', 'tool_decision', 'tool_result', 'api_error'], 'id', 'the API request id; the call id of the counting (a call is counted once)', 'counted'),
  f('client_request_id', ['api_request'], 'id', 'client-side id of the request', 'stored'),
  f('query_source', ['api_request', 'assistant_response', 'api_refusal', 'api_error'], 'string', 'who asked: repl_main_thread (you), sdk (app / cloud), subagent or agent:<type> (a sub-agent call), anything else a background request (prompt_suggestion, generate_session_title, away_summary ...); sub-agent and background calls get turn rows of their own', 'counted'),
  f('agent_id', ['api_request'], 'id', 'set on sub-agent calls only; makes the call a sub-agent call', 'counted', { seen: false }),
  f('parent_agent_id', ['api_request'], 'id', 'the agent that started a sub-agent', 'stored', { seen: false }),

  // ---- user_prompt / assistant_response
  f('prompt', ['user_prompt'], 'string', 'the text of the message (arrives as <REDACTED>)', 'content'),
  f('prompt_text', ['user_prompt'], 'string', 'the text of the message again (arrives as <REDACTED>)', 'content'),
  f('prompt_length', ['user_prompt'], 'int', 'length of the message in characters', 'stored'),
  f('message.uuid', ['user_prompt', 'assistant_response'], 'id', 'id of the message', 'stored'),
  f('command_name', ['user_prompt'], 'string', 'the slash command, when the message was one (ide ...)', 'stored'),
  f('command_source', ['user_prompt'], 'string', 'where the command comes from (builtin ...)', 'stored'),
  f('response', ['assistant_response'], 'string', 'the text of the answer (arrives as <REDACTED>)', 'content'),
  f('response_length', ['assistant_response'], 'int', 'length of the answer in characters', 'stored'),

  // ---- api_refusal
  f('attempt', ['api_refusal', 'api_error'], 'int', 'which attempt was refused', 'stored'),
  f('has_category', ['api_refusal'], 'bool', 'the refusal names a category', 'stored'),
  f('has_explanation', ['api_refusal'], 'bool', 'the refusal carries an explanation', 'stored'),
  f('server_fallback_hop', ['api_refusal'], 'int', 'how many hops to a fallback model happened', 'stored'),

  // ---- tools and permissions
  f('tool_name', ['tool_decision', 'tool_result', 'safety_event'], 'string', 'the tool (Bash, Read, Edit, PowerShell ...)', 'stored'),
  f('tool_source', ['tool_decision', 'safety_event'], 'string', 'where the tool comes from (builtin ...)', 'stored'),
  f('tool_use_id', ['tool_decision', 'tool_result', 'safety_event'], 'id', 'id of one use of a tool', 'stored'),
  f('decision', ['tool_decision', 'safety_event'], 'string', 'accept or reject', 'stored'),
  f('source', ['tool_decision'], 'string', 'who decided: config, user_reject ...', 'stored'),
  f('permission_mode', ['tool_decision', 'safety_event'], 'string', 'the permission mode (default, auto ...)', 'stored'),
  f('classifier_verdict', ['tool_decision'], 'string', 'what the safety classifier said (allow ...)', 'stored'),
  f('success', ['tool_result', 'compaction', 'at_mention', 'auth'], 'bool', 'the tool finished without an error', 'stored'),
  f('tool_input_size_bytes', ['tool_result'], 'int', 'size of the tool input (not its content)', 'stored'),
  f('tool_result_size_bytes', ['tool_result'], 'int', 'size of the tool result (not its content)', 'stored'),
  f('decision_source', ['tool_result', 'safety_event'], 'string', 'who allowed the run', 'stored'),
  f('decision_type', ['tool_result'], 'string', 'accept or reject', 'stored'),
  f('category', ['safety_event'], 'string', 'kind of safety check', 'stored'),
  f('reason_code', ['safety_event'], 'string', 'why it stopped or allowed (workingDir ...)', 'stored'),
  f('reason_type', ['safety_event'], 'string', 'kind of reason', 'stored'),
  f('tool_class', ['safety_event'], 'string', 'file, shell ...', 'stored'),
  f('sandbox_enabled', ['safety_event'], 'bool', 'the sandbox was on', 'stored'),
  f('sandbox_violation_count', ['safety_event'], 'int', 'sandbox violations', 'stored'),
  f('from_mode', ['permission_mode_changed'], 'string', 'the permission mode before', 'stored'),
  f('to_mode', ['permission_mode_changed'], 'string', 'the permission mode after', 'stored'),

  // ---- hooks
  f('hook_event', ['hook_registered', 'hook_execution_start', 'hook_execution_complete', 'safety_event'], 'string', 'the event the hook is for (Stop ...)', 'stored'),
  f('hook_name', ['hook_execution_start', 'hook_execution_complete'], 'string', 'the hook', 'stored'),
  f('hook_source', ['hook_registered', 'hook_execution_start', 'hook_execution_complete'], 'string', 'where it is defined (merged, settings ...)', 'stored'),
  f('hook_type', ['hook_registered'], 'string', 'command, prompt ...', 'stored'),
  f('num_hooks', ['hook_execution_start', 'hook_execution_complete'], 'int', 'hooks for this event', 'stored'),
  f('managed_only', ['hook_execution_start', 'hook_execution_complete'], 'bool', 'only managed hooks are allowed', 'stored'),
  f('safe_mode', ['hook_registered', 'hook_execution_start', 'hook_execution_complete', 'plugin_loaded'], 'bool', 'safe mode is on', 'stored'),
  f('num_success', ['hook_execution_complete'], 'int', 'hooks that succeeded', 'stored'),
  f('num_blocking', ['hook_execution_complete'], 'int', 'hooks that blocked', 'stored'),
  f('num_cancelled', ['hook_execution_complete'], 'int', 'hooks that were cancelled', 'stored'),
  f('num_non_blocking_error', ['hook_execution_complete'], 'int', 'hooks that failed without blocking', 'stored'),
  f('num_outputs_persisted', ['hook_execution_complete'], 'int', 'hook outputs kept', 'stored'),
  f('total_duration_ms', ['hook_execution_complete'], 'int', 'how long the hooks took', 'stored'),
  f('stdout_chars', ['hook_execution_complete'], 'int', 'length of the hooks output', 'stored'),
  f('system_message_chars', ['hook_execution_complete'], 'int', 'length of the system message the hooks added', 'stored'),
  f('additional_context_chars', ['hook_execution_complete'], 'int', 'length of the context the hooks added', 'stored'),
  f('initial_user_message_chars', ['hook_execution_complete'], 'int', 'length of the first message the hooks added', 'stored'),

  // ---- start-up
  f('plugin.name', ['plugin_loaded', 'mcp_server_connection', 'skill_activated', 'plugin_installed', 'subagent_completed'], 'string', 'the plugin', 'stored'),
  f('plugin_id_hash', ['plugin_loaded', 'mcp_server_connection', 'subagent_completed'], 'id', 'hash of the plugin id', 'stored'),
  f('plugin.scope', ['plugin_loaded'], 'string', 'where the plugin is installed (user-local ...)', 'stored'),
  f('marketplace.name', ['plugin_loaded', 'skill_activated', 'plugin_installed'], 'string', 'the marketplace it came from', 'stored'),
  f('enabled_via', ['plugin_loaded'], 'string', 'how it was enabled (user-install ...)', 'stored'),
  f('has_hooks', ['plugin_loaded'], 'bool', 'the plugin has hooks', 'stored'),
  f('has_mcp', ['plugin_loaded'], 'bool', 'the plugin has an MCP server', 'stored'),
  f('host_owned_mcp', ['plugin_loaded'], 'bool', 'the MCP server belongs to the host', 'stored'),
  f('agent_path_count', ['plugin_loaded'], 'int', 'agents in the plugin', 'stored'),
  f('command_path_count', ['plugin_loaded'], 'int', 'commands in the plugin', 'stored'),
  f('skill_path_count', ['plugin_loaded'], 'int', 'skills in the plugin', 'stored'),
  f('status', ['mcp_server_connection'], 'string', 'connected or failed', 'stored'),
  f('error_code', ['mcp_server_connection', 'internal_error'], 'string', 'why a connection failed (ENDPOINT_NOT_FOUND ...)', 'stored'),
  f('transport_type', ['mcp_server_connection'], 'string', 'http, ws-ide, claudeai-proxy ...', 'stored'),
  f('server_scope', ['mcp_server_connection'], 'string', 'dynamic, claudeai ...', 'stored'),
  f('is_plugin', ['mcp_server_connection'], 'bool', 'the server comes from a plugin', 'stored'),
  f('managed_settings.helper.applied', ['managed_settings_resolved'], 'string', 'was a settings helper applied', 'stored'),
  f('managed_settings.helper.state', ['managed_settings_resolved'], 'string', 'state of the helper', 'stored'),
  f('managed_settings.source_behavior', ['managed_settings_resolved'], 'string', 'which settings source wins (first-wins ...)', 'stored'),
  f('managed_settings.trigger', ['managed_settings_resolved'], 'string', 'what caused the read (startup ...)', 'stored'),

  // ---- housekeeping
  f('artifacts_deleted', ['retention_sweep'], 'int', 'old artifacts removed', 'stored'),
  f('transcripts_deleted', ['retention_sweep'], 'int', 'old transcripts removed', 'stored'),
  f('session_files_deleted', ['retention_sweep'], 'int', 'old session files removed', 'stored'),
  f('files_past_cutoff', ['retention_sweep'], 'int', 'files older than the cutoff', 'stored'),
  f('files_retained_fresh', ['retention_sweep'], 'int', 'files kept because they are fresh', 'stored'),
  f('history_entries_pruned', ['retention_sweep'], 'int', 'history entries removed', 'stored'),
  f('error_count', ['retention_sweep'], 'int', 'errors during the sweep', 'stored'),
  f('period_days', ['retention_sweep'], 'int', 'retention period', 'stored'),
  f('result', ['retention_sweep'], 'string', 'complete ...', 'stored'),
  f('used_default', ['retention_sweep'], 'bool', 'the default period was used', 'stored'),
  f('transcripts_exempted_desktop', ['retention_sweep'], 'int', 'transcripts the Claude app kept', 'stored'),
  // ---- documented, not yet seen in a real payload (monitoring docs, second half)
  f('wsl.version', ALL, 'string', 'WSL version, only when running on Windows Subsystem for Linux', 'stored', { seen: false, only: 'WSL' }),
  f('trigger', ['compaction', 'permission_mode_changed'], 'string', 'what caused it: compaction auto or manual; a mode change shift_tab, exit_plan_mode, auto_gate_denied', 'stored', { seen: false }),
  f('pre_tokens', ['compaction'], 'int', 'approximate tokens before the compaction', 'stored', { seen: false }),
  f('post_tokens', ['compaction'], 'int', 'approximate tokens after the compaction', 'stored', { seen: false }),
  f('precompute_reuse', ['compaction'], 'string', 'whether a summary prepared in the background was reused (hit, miss_*)', 'stored', { seen: false }),
  f('agent_type', ['subagent_completed'], 'string', 'the sub-agent type (custom agents appear as "custom")', 'stored', { seen: false }),
  f('agent.source', ['subagent_completed'], 'string', 'where the agent definition came from (built-in, plugin, userSettings ...)', 'stored', { seen: false }),
  f('is_built_in', ['subagent_completed'], 'bool', 'a built-in sub-agent', 'stored', { seen: false }),
  f('is_async', ['subagent_completed'], 'bool', 'it ran in the background', 'stored', { seen: false }),
  f('total_tokens', ['subagent_completed'], 'int', "tokens of the sub-agent's final request (its context size at the end, not a sum)", 'stored', { seen: false }),
  f('total_tool_uses', ['subagent_completed'], 'int', 'tool calls the sub-agent made in the whole run', 'stored', { seen: false }),
  f('final_model', ['subagent_completed'], 'string', 'the model that produced the final answer (differs from model after a switch)', 'stored', { seen: false }),
  f('model_swapped', ['subagent_completed'], 'bool', 'more than one model served the sub-agent', 'stored', { seen: false }),
  f('status_code', ['api_error', 'api_retries_exhausted', 'auth'], 'int', 'HTTP status code of the failure (absent for non-HTTP errors)', 'stored', { seen: false }),
  f('total_attempts', ['api_retries_exhausted'], 'int', 'attempts made before giving up', 'stored', { seen: false }),
  f('total_retry_duration_ms', ['api_retries_exhausted'], 'int', 'wall-clock time across all attempts', 'stored', { seen: false }),
  f('error', ['api_error', 'api_retries_exhausted', 'compaction', 'mcp_server_connection'], 'string', 'the error message (may hold text)', 'content', { seen: false }),
  f('skill.name', ['skill_activated'], 'string', 'the skill; user-defined and third-party skills appear as "custom_skill"', 'stored', { seen: false }),
  f('invocation_trigger', ['skill_activated'], 'string', 'user-slash, claude-proactive or nested-skill', 'stored', { seen: false }),
  f('skill.source', ['skill_activated'], 'string', 'where the skill was loaded from (bundled, userSettings, projectSettings, plugin)', 'stored', { seen: false }),
  f('skill.kind', ['skill_activated'], 'string', 'workflow when the skill is a workflow skill', 'stored', { seen: false }),
  f('mention_type', ['at_mention'], 'string', 'file, directory, agent, mcp_resource or peer', 'stored', { seen: false }),
  f('action', ['auth'], 'string', 'login or logout', 'stored', { seen: false }),
  f('auth_method', ['auth'], 'string', 'oauth ...', 'stored', { seen: false }),
  f('error_category', ['auth'], 'string', 'kind of failure (never the message)', 'stored', { seen: false }),
  f('error_name', ['internal_error'], 'string', 'the error class name (TypeError ...)', 'stored', { seen: false }),
  f('marketplace.is_official', ['plugin_installed'], 'bool', 'the marketplace is an official one', 'stored', { seen: false }),
  f('install.trigger', ['plugin_installed'], 'string', 'cli or ui', 'stored', { seen: false }),
  f('plugin.version', ['plugin_installed', 'plugin_loaded'], 'string', 'plugin version', 'stored', { seen: false }),
  f('event_type', ['feedback_survey'], 'string', 'appeared, responded ...', 'stored', { seen: false }),
  f('appearance_id', ['feedback_survey'], 'id', 'ties the events of one survey', 'stored', { seen: false }),
  f('survey_type', ['feedback_survey'], 'string', 'which survey', 'stored', { seen: false }),
  f('enabled_via_override', ['feedback_survey'], 'bool', 'the survey override variable is set', 'stored', { seen: false }),
  f('skip_reason', ['retention_sweep'], 'string', 'why the sweep was paused (only when result is skipped)', 'stored', { seen: false }),
  f('rule_source', ['safety_event'], 'string', 'settings source of the rule involved (userSettings, policySettings ...)', 'stored', { seen: false }),
  f('grant_scope', ['safety_event'], 'string', 'once or session, for a prompt approved without saving a rule', 'stored', { seen: false }),
  f('circuit_breaker', ['safety_event'], 'string', 'the built-in safety check (dangerousRemoval, outsideReadsBlocked ...)', 'stored', { seen: false }),
  f('classifier_category', ['safety_event'], 'string', 'the rule behind an auto mode block (only with tool details on)', 'stored', { seen: false }),
  f('error.type', ['managed_settings_resolved'], 'string', 'why a managed policy stopped the session', 'stored', { seen: false }),
  f('managed_settings.helper.entry', ['managed_settings_resolved'], 'string', 'policyHelper when a helper was selected', 'stored', { seen: false }),
  f('managed_settings.helper.path', ['managed_settings_resolved'], 'string', 'the configured path of the policy helper', 'content', { seen: false }),
  f('tool_parameters', ['tool_decision', 'tool_result'], 'string', 'commands, server and tool names (only with tool details on)', 'content', { seen: false }),
  f('tool_input', ['tool_result'], 'string', 'file paths, URLs and other arguments (only with tool details on)', 'content', { seen: false }),
  f('server_name', ['mcp_server_connection'], 'string', 'the configured MCP server name (only with tool details on)', 'content', { seen: false }),
  f('hook_matcher', ['hook_registered'], 'string', 'the matcher of the hook (only with tool details on)', 'content', { seen: false }),
  f('hook_definitions', ['hook_execution_start', 'hook_execution_complete'], 'string', 'the hook configuration as JSON (only with tool details and tracing on)', 'content', { seen: false }),
]

export const FIELD_KEYS: ReadonlySet<string> = new Set(FIELDS.map(x => x.key))

/** The events that appear in the registry (besides '*'). */
export const EVENT_NAMES: string[] = [...new Set(FIELDS.flatMap(x => x.events).filter(e => e !== '*'))].sort()

const FROM_DOCS = 'Marked "documented only" when no real payload has carried the field yet.'

/** docs/OTLP-fields.md: generated, do not edit by hand. */
export function fieldsMarkdown(): string {
  const row = (x: Field): string => `| \`${x.key}\` | ${x.type} | ${x.what}${x.only ? ` *(only: ${x.only})*` : ''}${x.seen ? '' : ' *(documented only)*'} | ${x.handling} |`
  const head = '| field | type | meaning | handling |\n|---|---|---|---|'
  const out: string[] = [
    '# OTLP fields (generated)',
    '',
    'Generated from `worker/src/otlp-fields.ts` by `bun run fields`; do not edit by hand. To record a newly seen field, add it to that file and run the command.',
    '',
    '**Handling**: `counted` read for the token/cost counting (and kept with the event); `column` a column of the events table; `stored` kept in the event attributes (numbers, flags and identifier-like words only); `identity` never kept (who the user or the machine is); `content` never kept (may hold the text of the conversation; the Claude app sends `<REDACTED>`). ' + FROM_DOCS,
    '',
    '## On every event',
    head, ...FIELDS.filter(x => x.events[0] === '*').map(row), '',
  ]
  for (const event of EVENT_NAMES) {
    out.push(`## \`${event}\``, head, ...FIELDS.filter(x => x.events.includes(event)).map(row), '')
  }
  const counts = (h: Handling): number => FIELDS.filter(x => x.handling === h).length
  out.push('## Totals', '', `${FIELDS.length} fields: ${counts('counted')} counted, ${counts('column')} columns, ${counts('stored')} stored, ${counts('identity')} identity (never kept), ${counts('content')} content (never kept).`, '')
  return out.join('\n')
}
