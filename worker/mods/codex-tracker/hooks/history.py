#!/usr/bin/env python3
# Token Tracker plugin for Codex: the token history from before OpenTelemetry was switched on, read from Codex's own session files
# ($CODEX_HOME/sessions and archived_sessions, rollout-*.jsonl) on the device and sent as numbers to POST /v1/import (provider codex).
# The plugin's SessionStart hook runs it until one import has gone through; then a marker in the plugin's data folder stops it. Codex does
# not run async hooks yet, so the hook only starts the import as a detached process of its own and returns at once.
# The server keeps only calls from before the device's first Codex OTLP call (later ones OTLP counted), and an import sent twice counts once.
# Of a session file only four kinds of line are read: session_meta (the session id), turn_context (the model, and whether Codex started the
# session by itself: no approvals and a read-only sandbox), task_started (a new turn) and token_count (the numbers); a line of any other
# kind, the conversation included, is not even parsed. Nothing is printed; a failure leaves its message in last-error.txt.
import json, os, re, subprocess, sys, urllib.request
from datetime import datetime, timezone

HOME = os.environ.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
DATA = os.environ.get('PLUGIN_DATA') or os.path.join(HOME, 'token-tracker')
MARKER = os.path.join(DATA, 'history-imported')
KINDS = ('"session_meta"', '"turn_context"', '"task_started"', '"turn_started"', '"token_count"')
MODEL = re.compile(r'^[\w.:/+-]{1,64}$')
CHUNK = 500


def site_and_token():
    text = open(os.path.join(HOME, 'config.toml'), encoding='utf-8').read()
    site = re.search(r'endpoint = "(https?://[^"]+?)/v1/logs"', text)
    token = re.search(r'"x-device-token" = "([0-9a-f]{16,128})"', text)
    return (site.group(1), token.group(1)) if site and token else (None, None)


def session_files():
    for sub in ('sessions', 'archived_sessions'):
        for root, _, files in os.walk(os.path.join(HOME, sub)):
            for f in sorted(files):
                if f.startswith('rollout-') and f.endswith('.jsonl'):
                    yield os.path.join(root, f)


def ms_between(a, b):
    try:
        t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
        return max(0, int((t(b) - t(a)).total_seconds() * 1000))
    except (ValueError, TypeError):
        return 0


def calls(path):
    """The model calls of one session file, as import rows."""
    m = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', os.path.basename(path))
    session = m.group(1) if m else None
    model, own, new_turn, turn_start, turn_row, total, n = 'unknown', False, True, None, None, None, 0
    out = []
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if not any(k in line for k in KINDS):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            kind, p, ts = row.get('type'), row.get('payload') or {}, row.get('timestamp')
            if kind == 'session_meta' and isinstance(p.get('id'), str):
                session = p['id']
            elif kind == 'turn_context':
                if isinstance(p.get('model'), str) and MODEL.match(p['model']):
                    model = p['model']
                sandbox = p.get('sandbox_policy')
                own = p.get('approval_policy') == 'never' and isinstance(sandbox, dict) and sandbox.get('type') == 'read-only'
            elif kind == 'event_msg' and p.get('type') in ('task_started', 'turn_started'):
                new_turn, turn_start = True, ts
            elif kind == 'event_msg' and p.get('type') == 'token_count' and isinstance(p.get('info'), dict) and isinstance(ts, str):
                info = p['info']
                t = (info.get('total_token_usage') or {}).get('total_tokens')
                if t == total:  # the same totals again (a rate-limit update): no new call
                    continue
                total = t
                u = info.get('last_token_usage') or {}
                num = lambda k: u.get(k) if isinstance(u.get(k), int) and u.get(k) > 0 else 0
                cached, written, output = num('cached_input_tokens'), num('cache_write_input_tokens'), num('output_tokens')
                fresh = max(0, num('input_tokens') - cached - written)
                if not session or fresh + cached + written + output == 0:
                    continue
                n += 1
                call = {'id': f'cx:{session}:{n}', 'session': session, 'ts': ts, 'model': model, 'input': fresh, 'output': output,
                        'cache_read': cached, 'cache_creation': written, 'sub': False, 'first': new_turn, 'duration_ms': 0, 'bg': own}
                if new_turn:
                    turn_row, new_turn = call, False
                    turn_start = turn_start or ts
                if turn_row is not None and turn_start:
                    turn_row['duration_ms'] = ms_between(turn_start, ts)  # the turn's length, on its first call, as the Claude import does
                out.append(call)
    return out


def send(site, token, turns):
    body = json.dumps({'provider': 'codex', 'turns': turns}).encode()
    req = urllib.request.Request(site + '/v1/import', data=body, headers={'content-type': 'application/json', 'x-device-token': token}, method='POST')
    urllib.request.urlopen(req, timeout=60).read()


def main():
    if os.path.exists(MARKER):
        return
    site, token = site_and_token()
    if not site:
        return
    rows = []
    for path in session_files():
        try:
            rows += calls(path)
        except OSError:  # a file that cannot be read is skipped, not the whole import
            pass
    for i in range(0, len(rows), CHUNK):
        send(site, token, rows[i:i + CHUNK])
    os.makedirs(DATA, exist_ok=True)
    with open(MARKER, 'w', encoding='utf-8') as f:
        f.write(f'{datetime.now(timezone.utc).isoformat()} {len(rows)}\n')


def detach():
    """Runs the import in a process of its own (outliving the hook) and returns at once; nothing to do once the marker is there."""
    if os.path.exists(MARKER):
        return
    flags = 0x00000008 | 0x00000200 if os.name == 'nt' else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([sys.executable, os.path.abspath(__file__), '--run'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, close_fds=True, start_new_session=os.name != 'nt', creationflags=flags)


if __name__ == '__main__':
    try:
        main() if '--run' in sys.argv[1:] else detach()
    except Exception as e:
        try:
            os.makedirs(DATA, exist_ok=True)
            with open(os.path.join(DATA, 'last-error.txt'), 'w', encoding='utf-8') as f:
                f.write(f'{datetime.now(timezone.utc).isoformat()} history: {type(e).__name__}: {e}\n')
        except Exception:
            pass
    sys.exit(0)
