#!/usr/bin/env python3
# Token Tracker for Codex: the subscription's rate-limit windows, sent to the site (POST /v1/limits, provider codex).
# OTLP carries none, but Codex writes them into its session files: every `token_count` event of
# $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl has `rate_limits` { primary, secondary: { used_percent, window_minutes, resets_at } }.
# Codex runs this after every turn (`notify` in config.toml, written by install-codex.sh). It reads only those numbers from the newest
# session file; never the conversation, and not the argument Codex appends to the command (it holds the turn's text).
# The site and the device token come from the [otel] block install-codex.sh wrote; nothing is printed, a failure is silent.
import json, os, re, sys, urllib.request
from datetime import datetime, timedelta, timezone

HOME = os.environ.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
TAIL = 512 * 1024  # the newest token_count is near the end of the file
KINDS = {300: 'five_hour', 10080: 'seven_day'}


def site_and_token():
    text = open(os.path.join(HOME, 'config.toml'), encoding='utf-8').read()
    site = re.search(r'endpoint = "(https?://[^"]+?)/v1/logs"', text)
    token = re.search(r'"x-device-token" = "([0-9a-f]{16,128})"', text)
    return (site.group(1), token.group(1)) if site and token else (None, None)


def newest_sessions(n=3):
    """The most recently written session files, from the last two day folders (sessions/YYYY/MM/DD)."""
    root = os.path.join(HOME, 'sessions')
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


def main():
    site, token = site_and_token()
    if not site:
        return
    for path in newest_sessions():
        rl, stamp = latest_rate_limits(path)
        if rl:
            limits = readings(rl, stamp)
            if limits:
                req = urllib.request.Request(site + '/v1/limits', data=json.dumps({'provider': 'codex', 'limits': limits}).encode(),
                                             headers={'content-type': 'application/json', 'x-device-token': token}, method='POST')
                urllib.request.urlopen(req, timeout=5).read()
            return


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
