#!/usr/bin/env python3
# Token Tracker plugin for Codex: the session's activity as numbers, to POST /v1/activity (provider codex), as the Claude mod sends its own.
# One script for five hooks, told apart by hook_event_name in the hook's input:
# - SessionStart: the session's start, and its repository when the device allows it (GET /v1/config: off | name | hash). The repository is
#   found from the session's cwd (the nearest .git and its origin remote): owner/name, or 'h:' and the first 12 hex characters of the SHA-256
#   of the remote (of the folder when there is no remote). The cwd itself is never sent nor kept.
# - UserPromptSubmit: a turn starts (the time only; the pause since the last turn ended is the think time).
# - Stop / Interrupt: the turn ends (answer / aborted): its wall-clock time and how full the context was, from the numbers of the last
#   token_count line of the session's file (last_token_usage.input_tokens and model_context_window). Nothing else of that file is parsed.
# - SessionEnd: the session's end.
# Of the hook's input only hook_event_name, session_id, turn_id, transcript_path, cwd and reason are read: never the prompt, nor the last
# answer. Between hooks the times live in the plugin's data folder (activity/<session>.json). Nothing is printed; a hook never fails Codex.
import hashlib, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone

HOME = os.environ.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
DATA = os.environ.get('PLUGIN_DATA') or os.path.join(HOME, 'token-tracker')
STATE = os.path.join(DATA, 'activity')
ID = re.compile(r'^[\w-]{1,80}$')
WORD = re.compile(r'^[a-z_]{1,30}$')
REMOTE = re.compile(r'[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def ms(a, b):
    try:
        t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
        return max(0, int((t(b) - t(a)).total_seconds() * 1000))
    except (ValueError, TypeError, AttributeError):
        return None


def site_and_token():
    text = open(os.path.join(HOME, 'config.toml'), encoding='utf-8').read()
    site = re.search(r'endpoint = "(https?://[^"]+?)/v1/logs"', text)
    token = re.search(r'"x-device-token" = "([0-9a-f]{16,128})"', text)
    return (site.group(1), token.group(1)) if site and token else (None, None)


def call(site, token, path, body=None, timeout=5):
    req = urllib.request.Request(site + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', 'x-device-token': token}, method='GET' if body is None else 'POST')
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read() or b'{}')


def load(session):
    try:
        with open(os.path.join(STATE, session + '.json'), encoding='utf-8') as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save(session, state):
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, session + '.json'), 'w', encoding='utf-8') as f:
        json.dump(state, f)


def tidy():
    """Forgets the times of sessions that never ended (no SessionEnd) after a week."""
    try:
        for f in os.listdir(STATE):
            p = os.path.join(STATE, f)
            if f.endswith('.json') and time.time() - os.path.getmtime(p) > 7 * 86400:
                os.remove(p)
    except OSError:
        pass


def git_dir(cwd):
    """The .git folder (its common folder for a worktree) above cwd, and the folder it belongs to."""
    d = os.path.abspath(cwd)
    while True:
        g = os.path.join(d, '.git')
        if os.path.isdir(g):
            return g, d
        if os.path.isfile(g):  # a worktree or a submodule: "gitdir: <path>"
            m = re.match(r'gitdir:\s*(.+)', open(g, encoding='utf-8').read().strip())
            if m:
                gd = os.path.normpath(os.path.join(d, m.group(1).strip()))
                common = os.path.join(gd, 'commondir')
                if os.path.isfile(common):
                    gd = os.path.normpath(os.path.join(gd, open(common, encoding='utf-8').read().strip()))
                return gd, d
        up = os.path.dirname(d)
        if up == d:
            return None, None
        d = up


def origin(gd):
    """The url of the origin remote (else of the first remote) in the repository's config, or None."""
    try:
        text = open(os.path.join(gd, 'config'), encoding='utf-8', errors='replace').read()
    except OSError:
        return None
    remotes, current = {}, None
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r'\[remote\s+"([^"]+)"\]', line)
        if m:
            current = m.group(1)
        elif line.startswith('['):
            current = None
        elif current:
            m = re.match(r'url\s*=\s*(.+)', line)
            if m:
                remotes.setdefault(current, m.group(1).strip())
    return remotes.get('origin') or next(iter(remotes.values()), None)


def project(cwd, mode):
    """(project, note): the repository as far as the device allows it, or a word saying why there is none."""
    if mode not in ('name', 'hash'):
        return None, 'off' if mode == 'off' else 'config_failed'
    if not isinstance(cwd, str) or not cwd:
        return None, 'no_repo'
    try:
        gd, root = git_dir(cwd)
    except OSError:
        return None, 'repo_failed'
    if not gd:
        return None, 'no_repo'
    remote = origin(gd)
    m = REMOTE.search(remote or '')
    if mode == 'name' and m:
        return f'{m.group(1)}/{m.group(2)}', None
    return 'h:' + hashlib.sha256((remote or root).encode()).hexdigest()[:12], None


def context(path):
    """(tokens, window) of the last token_count line in the session's file: numbers only; the other lines are not parsed."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 1_000_000))  # the end of the file is enough
            lines = f.read().decode('utf-8', 'replace').splitlines()
    except (OSError, TypeError):
        return None, None
    for line in reversed(lines):
        if '"token_count"' not in line:
            continue
        try:
            p = json.loads(line).get('payload') or {}
        except ValueError:
            continue
        info = p.get('info') if p.get('type') == 'token_count' else None
        if isinstance(info, dict):
            used = (info.get('last_token_usage') or {}).get('input_tokens')
            window = info.get('model_context_window')
            return (used if isinstance(used, int) and used >= 0 else None), (window if isinstance(window, int) and window > 0 else None)
    return None, None


def main():
    try:
        hook = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return
    event, session = hook.get('hook_event_name'), hook.get('session_id')
    if not isinstance(session, str) or not ID.match(session):
        return
    site, token = site_and_token()
    if not site:
        return
    state, at = load(session), now()

    def session_body(**end):
        return {'id': session, 'started_at': state.get('started_at') or at, 'project': state.get('project'),
                'project_note': state.get('project_note'), **end}

    if event == 'SessionStart':
        tidy()
        state.setdefault('started_at', at)  # a resumed session keeps its start
        if 'project_note' not in state and 'project' not in state:
            try:
                mode = str(call(site, token, '/v1/config').get('project', 'off'))
            except Exception:
                mode = 'config_failed'
            state['project'], state['project_note'] = project(hook.get('cwd'), mode)
        save(session, state)
        call(site, token, '/v1/activity', {'provider': 'codex', 'session': session_body()})
        state['sent'] = True
        save(session, state)
    elif event == 'UserPromptSubmit':
        turn = hook.get('turn_id')
        state['turn'] = {'id': turn if isinstance(turn, str) and ID.match(turn) else f'{session[:36]}-{int(time.time() * 1000)}', 'start': at,
                         'think_ms': ms(state['last_end'], at) if state.get('last_end') else None}
        state.setdefault('started_at', at)
        save(session, state)
    elif event in ('Stop', 'Interrupt'):
        turn = state.pop('turn', None)
        if not turn or not turn.get('start'):
            return
        tokens, window = context(hook.get('transcript_path'))
        row = {'id': turn['id'], 'session': session, 'ts': turn['start'], 'wall_ms': ms(turn['start'], at) or 0, 'think_ms': turn.get('think_ms'),
               'outcome': 'answer' if event == 'Stop' else 'aborted', 'context_tokens': tokens, 'context_window': window,
               'context_pct': round(100 * tokens / window, 1) if tokens is not None and window else None}
        state['last_end'] = at
        save(session, state)
        body = {'provider': 'codex', 'turns': [row]}
        if not state.get('sent'):  # a session that began before the plugin did: its start is its first turn
            body['session'] = session_body()
        call(site, token, '/v1/activity', body)
        state['sent'] = True
        save(session, state)
    elif event == 'SessionEnd':
        reason = hook.get('reason')
        call(site, token, '/v1/activity', {'provider': 'codex', 'session': session_body(ended_at=at, end_reason=reason if isinstance(reason, str) and WORD.match(reason) else 'other')})
        try:
            os.remove(os.path.join(STATE, session + '.json'))
        except OSError:
            pass


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        try:
            os.makedirs(DATA, exist_ok=True)
            with open(os.path.join(DATA, 'last-error.txt'), 'w', encoding='utf-8') as f:
                f.write(f'{now()} activity: {type(e).__name__}\n')
        except Exception:
            pass
    sys.exit(0)
