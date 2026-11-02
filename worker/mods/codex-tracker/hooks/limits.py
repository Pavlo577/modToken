#!/usr/bin/env python3
# Token Tracker plugin for Codex: the subscription's rate-limit windows, sent to the site (POST /v1/limits, provider codex).
# OTLP carries none, but Codex writes them into its session files: every `token_count` event of
# $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl has `rate_limits` { primary, secondary: { used_percent, window_minutes, resets_at } }.
# The plugin's Stop hook runs this after every turn. Of the hook's input it reads `transcript_path` only (the input also holds the last
# answer, which is never looked at); of the session file only those numbers. Without a transcript path, the newest session file is read.
# The site and the device token come from the [otel] block install-codex.sh wrote; nothing is printed (a Stop hook's output would be
# read by Codex); a failure only leaves its message (never the token or the data) in last-error.txt in the plugin's data folder
# ($PLUGIN_DATA, else ~/.codex/token-tracker).
import json, os, re, sys, urllib.request
from datetime import datetime, timedelta, timezone

HOME = os.environ.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
TAIL = 512 * 1024  # the newest token_count is near the end of the file
KINDS = {300: 'five_hour', 10080: 'seven_day'}
DATA = os.environ.get('PLUGIN_DATA') or os.path.join(HOME, 'token-tracker')
HEARTBEAT = 3600  # the dashboard's log hears "limits sent" at most once an hour


def plugin_version():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.codex-plugin', 'plugin.json'), encoding='utf-8') as f:
            return str(json.load(f).get('version', ''))
    except (OSError, ValueError):
        return ''


def report(site, token, events, timeout=5):
    """The plugin's own log on the dashboard (POST /v1/plugin-log): kinds and counts, an error's type, never its message or a path."""
    try:
        body = json.dumps({'provider': 'codex', 'version': plugin_version(), 'events': events}).encode()
        req = urllib.request.Request(site + '/v1/plugin-log', data=body, headers={'content-type': 'application/json', 'x-device-token': token}, method='POST')
        urllib.request.urlopen(req, timeout=timeout).read()
    except Exception:
        pass


def site_and_token():
    text = open(os.path.join(HOME, 'config.toml'), encoding='utf-8').read()
    site = re.search(r'endpoint = "(https?://[^"]+?)/v1/logs"', text)
    token = re.search(r'"x-device-token" = "([0-9a-f]{16,128})"', text)
    return (site.group(1), token.group(1)) if site and token else (None, None)


def newest_sessions(n=3):
    """The most recently written session files, from the last two day folders (sessions/YYYY/MM/DD)."""
    root = os.path.join(HOME, 'sessions')
    if not os.path.isdir(root):
        return []
    days = []
    for y in sorted(os.listdir(root), reverse=True)[:2]:
        for m in sorted(os.listdir(os.path.join(root, y)), reverse=True)[:2]:
            for d in sorted(os.listdir(os.path.join(root, y, m)), reverse=True)[:2]:
                days.append(os.path.join(root, y, m, d))
    days = sorted(days, reverse=True)[:2]
    files = [os.path.join(d, f) for d in days for f in os.listdir(d) if f.startswith('rollout-') and f.endswith('.jsonl')]
    return sorted(files, key=os.path.getmtime, reverse=True)[:n]


def latest_rate_limits(path):
    """The rate_limits of the file's last token_count event that has them, and that line's time."""
    with open(path, 'rb') as f:
        f.seek(max(0, os.path.getsize(path) - TAIL))
        lines = f.read().decode('utf-8', 'replace').splitlines()
    for line in reversed(lines):
        if '"token_count"' not in line or '"rate_limits"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        p = row.get('payload') or {}
        if row.get('type') == 'event_msg' and p.get('type') == 'token_count' and isinstance(p.get('rate_limits'), dict):
            return p['rate_limits'], row.get('timestamp')
    return None, None


def readings(rl, stamp):
    out = []
    for name in ('primary', 'secondary'):
        w = rl.get(name)
        if not isinstance(w, dict) or not isinstance(w.get('used_percent'), (int, float)):
            continue
        reading = {'kind': KINDS.get(w.get('window_minutes'), name), 'percentUsed': round(float(w['used_percent']), 2)}
        if isinstance(w.get('resets_at'), (int, float)):
            reading['resetsAt'] = datetime.fromtimestamp(w['resets_at'], timezone.utc).isoformat()
        elif isinstance(w.get('resets_in_seconds'), (int, float)) and stamp:  # older Codex versions
            at = datetime.fromisoformat(stamp.replace('Z', '+00:00')) + timedelta(seconds=w['resets_in_seconds'])
            reading['resetsAt'] = at.isoformat()
        out.append(reading)
    return out


def transcript():
    """The session file the Stop hook names, if it is one of Codex's session files."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return None
        path = json.loads(sys.stdin.read(4 * 1024 * 1024) or '{}').get('transcript_path')
    except (ValueError, AttributeError, OSError):
        return None
    return path if isinstance(path, str) and path.endswith('.jsonl') and os.path.isfile(path) else None


def main():
    site, token = site_and_token()
    if not site:
        return
    named = transcript()
    for path in ([named] if named else []) + newest_sessions():
        rl, stamp = latest_rate_limits(path)
        if rl:
            limits = readings(rl, stamp)
            if limits:
                req = urllib.request.Request(site + '/v1/limits', data=json.dumps({'provider': 'codex', 'limits': limits}).encode(),
                                             headers={'content-type': 'application/json', 'x-device-token': token}, method='POST')
                urllib.request.urlopen(req, timeout=5).read()
                beat = os.path.join(DATA, 'limits-reported')
                if not os.path.exists(beat) or datetime.now().timestamp() - os.path.getmtime(beat) > HEARTBEAT:
                    os.makedirs(DATA, exist_ok=True)
                    open(beat, 'w').close()
                    report(site, token, [{'kind': 'limits', 'n': len(limits)}])
            return


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        try:
            os.makedirs(DATA, exist_ok=True)
            with open(os.path.join(DATA, 'last-error.txt'), 'w', encoding='utf-8') as f:
                f.write(f'{datetime.now(timezone.utc).isoformat()} {type(e).__name__}: {e}\n')
            site, token = site_and_token()
            if site:
                report(site, token, [{'kind': 'error', 'error': type(e).__name__, 'stage': 'limits'}])
        except Exception:
            pass
    sys.exit(0)
