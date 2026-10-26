-- token_events.kind: main (the prompt's own calls, counted as a turn), sub (a sub-agent's), bg (background requests: prompt suggestions, titles,
-- summaries, compaction). Rows written before keep 'main': they mixed the three, as one row per prompt.
ALTER TABLE token_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';
-- mod_sessions.project_note: why the mod sent no project (off, no_repo, config_failed ...), so a missing project can be explained.
ALTER TABLE mod_sessions ADD COLUMN project_note TEXT;
