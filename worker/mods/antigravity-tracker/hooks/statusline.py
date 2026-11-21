#!/usr/bin/env python3
# Token Tracker statusLine bridge for Antigravity CLI (`agy`):
# Reads ONLY numeric token, cost, model, and subscription quota fields from Antigravity's documented statusLine JSON payload
# (never email, conversation_title, cwd, workspace, or transcript_path).
# - Token & cost deltas -> OTLP/HTTP JSON (POST /v1/logs, service.name "antigravity-cli", event "antigravity.api_request")
# - Subscription quota buckets -> POST /v1/limits (provider "antigravity")
# - Latest context window fill -> saved locally for hooks/activity.py (Stop hook)
# Network delivery runs in a detached child process (--deliver) so statusLine returns immediately (<30ms) and never stalls the TUI.
# Pass --sync for synchronous delivery in tests. Always exits 0.
import json, os, re, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone

CLI_DIR = os.environ.get('ANTIGRAVITY_CLI_DIR') or os.path.join(os.path.expanduser('~'), '.gemini', 'antigravity-cli')
DATA = os.environ.get('ANTIGRAVITY_TRACKER_DIR') or os.path.join(CLI_DIR, 'token-tracker')
STATE_DIR = os.path.join(DATA, 'state')
ACT_DIR = os.path.join(DATA, 'activity')
ID = re.compile(r'^[\w-]{1,80}$')
HEARTBEAT = 3600  # at most one "limits" heartbeat per hour in /v1/plugin-log


def now_utc():
    return datetime.now(timezone.utc)


def iso_now(dt=None):
    return (dt or now_utc()).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


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


def load_config():
    cfg = load_json(os.path.join(DATA, 'config.json'))
    site = cfg.get('site') if isinstance(cfg.get('site'), str) else ''
    token = cfg.get('token') if isinstance(cfg.get('token'), str) else ''
    chain = cfg.get('chain_command') if isinstance(cfg.get('chain_command'), str) else ''
    site = site.rstrip('/')
    if not site.startswith(('http://', 'https://')) or not token:
        return None, None, chain
    return site, token, chain


def post(site, token, path, body, timeout=5):
    req = urllib.request.Request(
        site + path,
        data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json', 'x-device-token': token},
        method='POST',
    )
    urllib.request.urlopen(req, timeout=timeout).read()


def report_log(site, token, events, timeout=5):
    try:
        post(site, token, '/v1/plugin-log', {'provider': 'antigravity', 'version': plugin_version(), 'events': events}, timeout=timeout)
    except Exception:
        pass


def record_error(site, token, stage, err):
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(os.path.join(DATA, 'last-error.txt'), 'w', encoding='utf-8') as f:
            f.write(f'{iso_now()} {stage}: {type(err).__name__}\n')
        if site and token:
            report_log(site, token, [{'kind': 'error', 'error': type(err).__name__, 'stage': stage}])
    except Exception:
        pass


def non_neg_int(v):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else 0


def non_neg_float(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else 0.0


def clean_str(v, limit=120):
    return v.strip()[:limit] if isinstance(v, str) else ''


def quota_kind(name, reset_in_seconds):
    low = name.lower()
    if any(k in low for k in ('week', '7d', 'seven')) or (isinstance(reset_in_seconds, (int, float)) and reset_in_seconds > 86400):
        return 'seven_day'
    if any(k in low for k in ('5h', 'five', 'hour', 'session')) or (isinstance(reset_in_seconds, (int, float)) and 0 < reset_in_seconds <= 21600):
        return 'five_hour'
    kind = re.sub(r'[^a-z]+', '_', low).strip('_')[:30]
    return kind or 'quota'


def parse_quotas(quota_obj, dt_now):
    if not isinstance(quota_obj, dict):
        return []
    by_kind = {}
    for bucket, info in quota_obj.items():
        if not isinstance(bucket, str) or not isinstance(info, dict) or info.get('disabled') is True:
            continue
        frac = info.get('remaining_fraction')
        if not isinstance(frac, (int, float)) or isinstance(frac, bool):
            continue
        pct = round(max(0.0, min(100.0, (1.0 - float(frac)) * 100.0)), 2)
        reset_in = info.get('reset_in_seconds')
        resets_at = ''
        if isinstance(info.get('reset_time'), str) and info['reset_time'].strip():
            resets_at = info['reset_time'].strip()[:40]
        elif isinstance(reset_in, (int, float)) and not isinstance(reset_in, bool) and reset_in >= 0:
            rt = (dt_now + timedelta(seconds=float(reset_in))).replace(second=0, microsecond=0)
            resets_at = rt.isoformat().replace('+00:00', 'Z')
        kind = quota_kind(bucket, reset_in)
        prev = by_kind.get(kind)
        if prev is None or pct > prev['percentUsed']:
            entry = {'kind': kind, 'percentUsed': pct}
            if resets_at:
                entry['resetsAt'] = resets_at
            by_kind[kind] = entry
    return [by_kind[k] for k in sorted(by_kind.keys())]


def otlp_record(session_id, prompt_id, call_id, dt_now, model_id, effort, new_input, output, cache_read, cache_write, duration_ms, cost_micros, query_source, version):
    attrs = [
        {'key': 'event.name', 'value': {'stringValue': 'antigravity.api_request'}},
        {'key': 'session.id', 'value': {'stringValue': session_id}},
        {'key': 'prompt.id', 'value': {'stringValue': prompt_id}},
        {'key': 'request_id', 'value': {'stringValue': call_id}},
        {'key': 'model', 'value': {'stringValue': model_id}},
        {'key': 'input_tokens', 'value': {'intValue': str(new_input)}},
        {'key': 'output_tokens', 'value': {'intValue': str(output)}},
        {'key': 'cache_read_tokens', 'value': {'intValue': str(cache_read)}},
        {'key': 'cache_creation_tokens', 'value': {'intValue': str(cache_write)}},
        {'key': 'duration_ms', 'value': {'intValue': str(duration_ms)}},
        {'key': 'query_source', 'value': {'stringValue': query_source}},
    ]
    if cost_micros > 0:
        attrs.append({'key': 'cost_usd_micros', 'value': {'intValue': str(cost_micros)}})
    if effort:
        attrs.append({'key': 'effort', 'value': {'stringValue': effort}})
    if version:
        attrs.append({'key': 'service.version', 'value': {'stringValue': version}})
    ns = str(int(dt_now.timestamp() * 1_000_000_000))
    return {
        'resourceLogs': [{
            'resource': {'attributes': [{'key': 'service.name', 'value': {'stringValue': 'antigravity-cli'}}]},
            'scopeLogs': [{'logRecords': [{'timeUnixNano': ns, 'attributes': attrs}]}],
        }],
    }


def tidy_states():
    try:
        cutoff = time.time() - 7 * 86400
        for name in os.listdir(STATE_DIR):
            p = os.path.join(STATE_DIR, name)
            if name.endswith('.json') and name != 'quota.json' and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass


def deliver(job_path):
    try:
        job = load_json(job_path)
    finally:
        try:
            os.unlink(job_path)
        except OSError:
            pass
    site, token, _ = load_config()
    if not site or not token:
        return
    if 'otlp' in job:
        try:
            post(site, token, '/v1/logs', job['otlp'], timeout=5)
        except Exception as e:
            record_error(site, token, 'statusline', e)
    if 'limits' in job:
        try:
            post(site, token, '/v1/limits', {'provider': 'antigravity', 'limits': job['limits']}, timeout=5)
            beat = os.path.join(DATA, 'limits-reported')
            if not os.path.exists(beat) or time.time() - os.path.getmtime(beat) > HEARTBEAT:
                os.makedirs(DATA, exist_ok=True)
                open(beat, 'w').close()
                report_log(site, token, [{'kind': 'limits', 'n': len(job['limits'])}])
        except Exception as e:
            record_error(site, token, 'limits', e)


def run_chain(chain_cmd, raw_stdin):
    if not chain_cmd:
        return
    try:
        r = subprocess.run(chain_cmd, input=raw_stdin, shell=True, capture_output=True, text=True, timeout=2)
        if r.stdout:
            sys.stdout.write(r.stdout)
            sys.stdout.flush()
    except Exception:
        pass


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == '--deliver':
        deliver(sys.argv[2])
        return

    sync = '--sync' in sys.argv[1:]
    raw_stdin = sys.stdin.read(2 * 1024 * 1024) if sys.stdin and not sys.stdin.isatty() else ''
    site, token, chain_cmd = load_config()
    if chain_cmd:
        run_chain(chain_cmd, raw_stdin)
    if not site or not token or not raw_stdin.strip():
        return

    try:
        payload = json.loads(raw_stdin)
    except ValueError:
        return
    if not isinstance(payload, dict):
        return

    dt_now = now_utc()
    job = {}

    # 1. Quota / subscription limits (independent of conversation_id)
    limits = parse_quotas(payload.get('quota'), dt_now)
    if limits:
        q_path = os.path.join(STATE_DIR, 'quota.json')
        q_state = load_json(q_path)
        sig = json.dumps([[x['kind'], x['percentUsed'], x.get('resetsAt', '')[:16]] for x in limits])
        if q_state.get('sig') != sig:
            save_json(q_path, {'sig': sig, 'ts': iso_now(dt_now)})
            job['limits'] = limits

    # 2. Session tokens, cost, and context window
    session_id = payload.get('conversation_id') or payload.get('session_id')
    if isinstance(session_id, str) and ID.match(session_id):
        cw = payload.get('context_window') if isinstance(payload.get('context_window'), dict) else {}
        cu = cw.get('current_usage') if isinstance(cw.get('current_usage'), dict) else None
        cost = payload.get('cost') if isinstance(payload.get('cost'), dict) else {}
        model = payload.get('model') if isinstance(payload.get('model'), dict) else {}

        total_in = non_neg_int(cw.get('total_input_tokens'))
        total_out = non_neg_int(cw.get('total_output_tokens'))
        cw_size = non_neg_int(cw.get('context_window_size'))
        used_pct = cw.get('used_percentage')
        pct_val = round(float(used_pct), 2) if isinstance(used_pct, (int, float)) and not isinstance(used_pct, bool) and 0 <= used_pct <= 100 else None
        cost_total = non_neg_float(cost.get('total_usd'))
        cost_sub = non_neg_float(cost.get('subagent_usd'))

        st_path = os.path.join(STATE_DIR, session_id + '.json')
        st = load_json(st_path)
        if not st:
            tidy_states()

        # Persist latest context fill for hooks/activity.py (Stop hook)
        ctx_tokens = non_neg_int(cu.get('input_tokens')) if cu else None
        if cu is not None or cw_size > 0 or pct_val is not None:
            st['last_context'] = {
                'tokens': ctx_tokens,
                'window': cw_size if cw_size > 0 else None,
                'pct': pct_val if pct_val is not None else (round(100.0 * ctx_tokens / cw_size, 1) if ctx_tokens is not None and cw_size > 0 else None),
            }

        prev_in = non_neg_int(st.get('total_input'))
        prev_out = non_neg_int(st.get('total_output'))
        prev_cost = non_neg_float(st.get('cost_usd'))
        prev_sub = non_neg_float(st.get('subagent_usd'))

        # Handle session reset if totals ever drop
        if total_in < prev_in or total_out < prev_out:
            prev_in, prev_out, prev_cost, prev_sub = 0, 0, 0.0, 0.0

        delta_in_total = total_in - prev_in
        delta_out = total_out - prev_out

        if delta_in_total > 0 or delta_out > 0:
            cu_sig = json.dumps(cu, sort_keys=True) if cu else ''
            cache_read = 0
            cache_write = 0
            if cu and cu_sig != st.get('last_cu_sig'):
                cache_read = non_neg_int(cu.get('cache_read_input_tokens'))
                cache_write = non_neg_int(cu.get('cache_creation_input_tokens'))

            if cache_read + cache_write <= delta_in_total:
                new_input = delta_in_total - cache_read - cache_write
            else:
                new_input = delta_in_total

            delta_cost_usd = max(0.0, cost_total - prev_cost)
            delta_sub_usd = max(0.0, cost_sub - prev_sub)
            cost_micros = int(round(delta_cost_usd * 1_000_000))
            query_source = 'subagent' if delta_sub_usd > 0 and delta_sub_usd >= delta_cost_usd * 0.99 else 'repl_main_thread'

            seq = non_neg_int(st.get('seq')) + 1
            act = load_json(os.path.join(ACT_DIR, session_id + '.json'))
            turn_info = act.get('turn') if isinstance(act.get('turn'), dict) else {}
            prompt_id = turn_info.get('id') if isinstance(turn_info.get('id'), str) and ID.match(turn_info['id']) else f'{session_id[:36]}-t{seq}'

            now_ms = int(dt_now.timestamp() * 1000)
            prev_ms = non_neg_int(st.get('last_call_ms'))
            duration_ms = 0
            if prev_ms > 0 and 0 < now_ms - prev_ms <= 10 * 60_000:
                duration_ms = now_ms - prev_ms
            elif isinstance(turn_info.get('start'), str):
                try:
                    t0 = int(datetime.fromisoformat(turn_info['start'].replace('Z', '+00:00')).timestamp() * 1000)
                    if 0 < now_ms - t0 <= 10 * 60_000:
                        duration_ms = now_ms - t0
                except ValueError:
                    pass

            model_id = clean_str(model.get('id') or model.get('display_name') or 'unknown', 100)
            effort = clean_str(model.get('effort'), 30)
            version = clean_str(payload.get('version'), 30)
            call_id = f'{session_id}:sl:{seq}'

            st.update({
                'seq': seq,
                'total_input': total_in,
                'total_output': total_out,
                'cost_usd': cost_total,
                'subagent_usd': cost_sub,
                'last_cu_sig': cu_sig,
                'last_call_ms': now_ms,
            })
            job['otlp'] = otlp_record(
                session_id, prompt_id, call_id, dt_now, model_id, effort,
                new_input, delta_out, cache_read, cache_write, duration_ms, cost_micros, query_source, version,
            )

        save_json(st_path, st)

    if not job:
        return

    os.makedirs(STATE_DIR, exist_ok=True)
    fd, job_path = tempfile.mkstemp(dir=STATE_DIR, prefix='.job-', suffix='.json')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(job, f)

    if sync:
        deliver(job_path)
    else:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), '--deliver', job_path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
