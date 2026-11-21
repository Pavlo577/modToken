#!/usr/bin/env python3
# Token Tracker plugin for Antigravity CLI (`agy`): session and turn activity as numbers, to POST /v1/activity (provider "antigravity").
# One script for three hooks, selected by argv[1]:
# - SessionStart: session start + repository (owner/name or h:<sha256[:12]>) per GET /v1/config (off | name | hash); cwd is never sent.
# - PreInvocation: marks the start of a turn (time + think_ms since previous Stop) so statusline.py can attach the same prompt.id.
# - Stop: ends the turn with wall_ms, think_ms, and context fill from statusline.py's state file.
# Reads ONLY conversationId, workspacePaths (used locally for git remote only) and modelName from stdin; never lastUserInput or transcriptPath.
# Always prints `{}` to stdout and exits 0 so Antigravity is never blocked.
import hashlib, json, os, re, sys, tempfile, time, urllib.request
from datetime import datetime, timezone

CLI_DIR = os.environ.get('ANTIGRAVITY_CLI_DIR') or os.path.join(os.path.expanduser('~'), '.gemini', 'antigravity-cli')
DATA = os.environ.get('ANTIGRAVITY_TRACKER_DIR') or os.path.join(CLI_DIR, 'token-tracker')
ACT_DIR = os.path.join(DATA, 'activity')
STATE_DIR = os.path.join(DATA, 'state')
ID = re.compile(r'^[\w-]{1,80}$')
REMOTE = re.compile(r'[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def ms(a, b):
    try:
        t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
        return max(0, int((t(b) - t(a)).total_seconds() * 1000))
    except (ValueError, TypeError, AttributeError):
        return None


def plugin_version():
    try:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'plugin.json')
        with open(p, encoding='utf-8') as f:
            return str(json.load(f).get('version', ''))
    except (OSError, ValueError):
        return ''


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            v = json.load(f)
            return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tt-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def site_and_token():
    cfg = load_json(os.path.join(DATA, 'config.json'))
    site = cfg.get('site') if isinstance(cfg.get('site'), str) else ''
    token = cfg.get('token') if isinstance(cfg.get('token'), str) else ''
    site = site.rstrip('/')
    return (site, token) if site.startswith(('http://', 'https://')) and token else (None, None)


def call(site, token, path, body=None, timeout=5):
    req = urllib.request.Request(
        site + path,
        data=None if body is None else json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json', 'x-device-token': token, 'user-agent': 'modToken-antigravity/1.0'},
        method='GET' if body is None else 'POST',
    )
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read() or b'{}')


def report_error(site, token, err):
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, 'last-error.txt'), 'w', encoding='utf-8') as f:
            f.write(f'{now()} activity: {type(err).__name__}\n')
        if site and token:
            call(site, token, '/v1/plugin-log', {
                'provider': 'antigravity',
                'version': plugin_version(),
                'events': [{'kind': 'error', 'error': type(err).__name__, 'stage': 'activity'}],
            })
    except Exception:
        pass


def tidy():
    try:
        for f in os.listdir(ACT_DIR):
            p = os.path.join(ACT_DIR, f)
            if f.endswith('.json') and time.time() - os.path.getmtime(p) > 7 * 86400:
                os.remove(p)
    except OSError:
        pass


def git_dir(cwd):
    d = os.path.abspath(cwd)
    while True:
        g = os.path.join(d, '.git')
        if os.path.isdir(g):
            return g, d
        if os.path.isfile(g):
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


def project(paths, mode):
    if mode not in ('name', 'hash'):
        return None, 'off' if mode == 'off' else 'config_failed'
    cwd = paths[0] if isinstance(paths, list) and paths and isinstance(paths[0], str) else None
    if not cwd:
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


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ''
    if event not in ('SessionStart', 'PreInvocation', 'Stop'):
        return
    try:
        hook = json.loads(sys.stdin.read() or '{}') if sys.stdin and not sys.stdin.isatty() else {}
    except ValueError:
        return
    if not isinstance(hook, dict):
        return
    session = hook.get('conversationId') or hook.get('sessionId')
    if not isinstance(session, str) or not ID.match(session):
        return
    site, token = site_and_token()
    if not site or not token:
        return

    st_path = os.path.join(ACT_DIR, session + '.json')
    state, at = load_json(st_path), now()

    def session_body(**end):
        return {
            'id': session,
            'started_at': state.get('started_at') or at,
            'project': state.get('project'),
            'project_note': state.get('project_note'),
            **end,
        }

    try:
        if event == 'SessionStart':
            tidy()
            state.setdefault('started_at', at)
            if 'project_note' not in state and 'project' not in state:
                try:
                    mode = str(call(site, token, '/v1/config').get('project', 'off'))
                except Exception:
                    mode = 'config_failed'
                state['project'], state['project_note'] = project(hook.get('workspacePaths'), mode)
            save_json(st_path, state)
            call(site, token, '/v1/activity', {'provider': 'antigravity', 'session': session_body()})
            state['sent'] = True
            save_json(st_path, state)
        elif event == 'PreInvocation':
            state.setdefault('started_at', at)
            if not isinstance(state.get('turn'), dict):
                seq = int(state.get('turn_seq') or 0) + 1
                state['turn_seq'] = seq
                state['turn'] = {
                    'id': f'{session[:36]}-t{seq}-{int(time.time() * 1000)}',
                    'start': at,
                    'think_ms': ms(state['last_end'], at) if state.get('last_end') else None,
                }
                save_json(st_path, state)
        elif event == 'Stop':
            turn = state.pop('turn', None)
            if not isinstance(turn, dict) or not turn.get('start'):
                return
            sl = load_json(os.path.join(STATE_DIR, session + '.json'))
            ctx = sl.get('last_context') if isinstance(sl.get('last_context'), dict) else {}
            tokens = ctx.get('tokens') if isinstance(ctx.get('tokens'), int) else None
            window = ctx.get('window') if isinstance(ctx.get('window'), int) else None
            pct = ctx.get('pct') if isinstance(ctx.get('pct'), (int, float)) else None
            row = {
                'id': turn['id'],
                'session': session,
                'ts': turn['start'],
                'wall_ms': ms(turn['start'], at) or 0,
                'think_ms': turn.get('think_ms'),
                'outcome': 'answer',
                'context_tokens': tokens,
                'context_window': window,
                'context_pct': round(float(pct), 1) if pct is not None else (round(100.0 * tokens / window, 1) if tokens is not None and window else None),
            }
            state['last_end'] = at
            save_json(st_path, state)
            body = {'provider': 'antigravity', 'turns': [row]}
            if not state.get('sent'):
                body['session'] = session_body()
            call(site, token, '/v1/activity', body)
            state['sent'] = True
            save_json(st_path, state)
    except Exception as e:
        report_error(site, token, e)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.stdout.write('{}\n')
    sys.stdout.flush()
    sys.exit(0)
