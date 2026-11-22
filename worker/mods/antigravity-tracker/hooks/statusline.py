#!/usr/bin/env python3
# Token Tracker statusLine bridge for Antigravity CLI (`agy`):
# Reads ONLY numeric token, cost, model, and subscription quota fields from Antigravity's documented statusLine JSON payload
# (never email, conversation_title, cwd, workspace, or transcript_path).
# - Normalizes model display names ("Gemini 4 Neon (High)" -> "gemini-4-neon-high") for pricing lookup.
# - Buffers OTLP logRecords & quota snapshots locally in `queue.json` (PC-side cache, up to 500 records) and flushes in batches
#   on turn end (agent_state=idle or --flush), >=10 buffered records, or >=flush_seconds (default 15s); keeps items on offline errors.
# - Network delivery runs in a detached child process (--deliver) so statusLine returns immediately (<30ms) and never stalls the TUI.
# Pass --sync for synchronous flush in tests, or --flush to trigger a background flush of the queue. Always exits 0.
import contextlib, json, os, re, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone

try:
    import fcntl
except ImportError:
    fcntl = None

CLI_DIR = os.environ.get('ANTIGRAVITY_CLI_DIR') or os.path.join(os.path.expanduser('~'), '.gemini', 'antigravity-cli')
DATA = os.environ.get('ANTIGRAVITY_TRACKER_DIR') or os.path.join(CLI_DIR, 'token-tracker')
STATE_DIR = os.path.join(DATA, 'state')
ACT_DIR = os.path.join(DATA, 'activity')
QUEUE_PATH = os.path.join(DATA, 'queue.json')
ID = re.compile(r'^[\w-]{1,80}$')
HEARTBEAT = 3600  # at most one "limits" heartbeat per hour in /v1/plugin-log
DEFAULT_FLUSH_SECONDS = 15
MAX_QUEUE_RECORDS = 500


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


@contextlib.contextmanager
def file_lock(name, blocking=True):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name)
    f = open(path, 'a+', encoding='utf-8')
    locked = False
    try:
        if fcntl is not None:
            flags = fcntl.LOCK_EX if blocking else (fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f.fileno(), flags)
            locked = True
        yield True
    except BlockingIOError:
        yield False
    finally:
        if locked and fcntl is not None:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        f.close()


def load_config():
    cfg = load_json(os.path.join(DATA, 'config.json'))
    site = cfg.get('site') if isinstance(cfg.get('site'), str) else ''
    token = cfg.get('token') if isinstance(cfg.get('token'), str) else ''
    chain = cfg.get('chain_command') if isinstance(cfg.get('chain_command'), str) else ''
    fs = cfg.get('flush_seconds')
    flush_sec = float(fs) if isinstance(fs, (int, float)) and not isinstance(fs, bool) and fs >= 0 else DEFAULT_FLUSH_SECONDS
    site = site.rstrip('/')
    if not site.startswith(('http://', 'https://')) or not token:
        return None, None, chain, flush_sec
    return site, token, chain, flush_sec


def post(site, token, path, body, timeout=5):
    req = urllib.request.Request(
        site + path,
        data=json.dumps(body).encode('utf-8'),
        headers={'content-type': 'application/json', 'x-device-token': token, 'user-agent': 'modToken-antigravity/1.0'},
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


def normalize_model(raw):
    s = clean_str(raw, 100)
    if not s:
        return 'unknown'
    if re.match(r'^[a-z0-9._-]+$', s):
        return s
    slug = re.sub(r'[()]+', '', s.lower())
    slug = re.sub(r'[\s/]+', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    if slug.startswith('claude-'):
        slug = re.sub(r'(\d)\.(\d)', r'\1-\2', slug)
    return slug or 'unknown'


def quota_kind(name, reset_in_seconds):
    low = name.lower()
    if any(k in low for k in ('week', '7d', 'seven')) or (isinstance(reset_in_seconds, (int, float)) and reset_in_seconds > 86400):
        return 'seven_day'
    if any(k in low for k in ('5h', 'five', 'hour', 'session')) or (isinstance(reset_in_seconds, (int, float)) and 0 < reset_in_seconds <= 21600):
        return 'five_hour'
    kind = re.sub(r'[^a-z]+', '_', low).strip('_')[:30]
    return kind or 'quota'


def pool_kind(bucket):
    k = re.sub(r'[^a-z0-9]+', '_', bucket.lower()).strip('_')
    if k and not ('a' <= k[0] <= 'z'):
        k = 'q_' + k
    return k[:30].strip('_') or 'quota'


def parse_quotas(quota_obj, dt_now):
    if not isinstance(quota_obj, dict):
        return []
    by_kind = {}
    counts = {}
    raw_entries = []
    obs_iso = iso_now(dt_now)
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
        counts[kind] = counts.get(kind, 0) + 1
        entry = {'kind': kind, 'percentUsed': pct, 'observedAt': obs_iso}
        if resets_at:
            entry['resetsAt'] = resets_at
        raw_entries.append((bucket, entry))
        prev = by_kind.get(kind)
        if prev is None or pct > prev['percentUsed']:
            by_kind[kind] = dict(entry)
    out = [by_kind[k] for k in sorted(by_kind.keys())]
    if any(c > 1 for c in counts.values()):
        extras = {}
        for bucket, entry in raw_entries:
            pk = pool_kind(bucket)
            if pk in ('five_hour', 'seven_day') or pk in by_kind:
                continue
            prev = extras.get(pk)
            if prev is None or entry['percentUsed'] > prev['percentUsed']:
                e = dict(entry)
                e['kind'] = pk
                extras[pk] = e
        for pk in sorted(extras.keys()):
            if len(out) >= 8:
                break
            out.append(extras[pk])
    return out


def otlp_log_record(session_id, prompt_id, call_id, dt_now, model_id, effort, new_input, output, cache_read, cache_write, duration_ms, cost_micros, query_source, version):
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
    return {'timeUnixNano': ns, 'attributes': attrs}


def record_request_id(rec):
    for a in rec.get('attributes') or []:
        if isinstance(a, dict) and a.get('key') == 'request_id':
            v = a.get('value')
            if isinstance(v, dict) and isinstance(v.get('stringValue'), str):
                return v['stringValue']
    return ''


def tidy_states():
    try:
        cutoff = time.time() - 7 * 86400
        for name in os.listdir(STATE_DIR):
            p = os.path.join(STATE_DIR, name)
            if name.endswith('.json') and name != 'quota.json' and os.path.getmtime(p) < cutoff:
                os.remove(p)
    except OSError:
        pass


def enqueue_work(record, limits, agent_state, flush_sec, force_flush):
    now_ms = int(time.time() * 1000)
    with file_lock('queue.lock', blocking=True):
        q = load_json(QUEUE_PATH)
        records = q.get('records') if isinstance(q.get('records'), list) else []
        q_limits = q.get('limits') if isinstance(q.get('limits'), list) else None
        last_flush_ms = non_neg_int(q.get('last_flush_ms'))

        if record is not None:
            records.append(record)
            if len(records) > MAX_QUEUE_RECORDS:
                records = records[-MAX_QUEUE_RECORDS:]
        if limits:
            q_limits = limits

        has_work = bool(records) or bool(q_limits)
        if has_work and not last_flush_ms:
            last_flush_ms = now_ms

        save_json(QUEUE_PATH, {'records': records, 'limits': q_limits, 'last_flush_ms': last_flush_ms})

        elapsed_ms = now_ms - last_flush_ms if last_flush_ms else 0
        return has_work and (
            force_flush
            or agent_state == 'idle'
            or (bool(q_limits) and agent_state != 'working' and not records)
            or len(records) >= 10
            or elapsed_ms >= int(flush_sec * 1000)
        )


def deliver_queue():
    site, token, _, _ = load_config()
    if not site or not token:
        return
    with file_lock('deliver.lock', blocking=False) as acquired:
        if not acquired:
            return
        with file_lock('queue.lock', blocking=True):
            q = load_json(QUEUE_PATH)
            records = q.get('records') if isinstance(q.get('records'), list) else []
            limits = q.get('limits') if isinstance(q.get('limits'), list) else None
        if not records and not limits:
            return

        sent_ids = set()
        limits_sent = False
        if records:
            otlp_body = {
                'resourceLogs': [{
                    'resource': {'attributes': [{'key': 'service.name', 'value': {'stringValue': 'antigravity-cli'}}]},
                    'scopeLogs': [{'logRecords': records}],
                }],
            }
            try:
                post(site, token, '/v1/logs', otlp_body, timeout=5)
                sent_ids = {record_request_id(r) for r in records if record_request_id(r)}
            except Exception as e:
                record_error(site, token, 'statusline', e)

        if limits:
            try:
                post(site, token, '/v1/limits', {'provider': 'antigravity', 'limits': limits}, timeout=5)
                limits_sent = True
                beat = os.path.join(DATA, 'limits-reported')
                if not os.path.exists(beat) or time.time() - os.path.getmtime(beat) > HEARTBEAT:
                    os.makedirs(DATA, exist_ok=True)
                    open(beat, 'w').close()
                    report_log(site, token, [{'kind': 'limits', 'n': len(limits)}])
            except Exception as e:
                record_error(site, token, 'limits', e)

        if sent_ids or limits_sent:
            with file_lock('queue.lock', blocking=True):
                cur = load_json(QUEUE_PATH)
                cur_recs = cur.get('records') if isinstance(cur.get('records'), list) else []
                if sent_ids:
                    cur_recs = [r for r in cur_recs if record_request_id(r) not in sent_ids]
                cur_lim = cur.get('limits') if isinstance(cur.get('limits'), list) else None
                if limits_sent and cur_lim == limits:
                    cur_lim = None
                save_json(QUEUE_PATH, {
                    'records': cur_recs,
                    'limits': cur_lim,
                    'last_flush_ms': 0 if not cur_recs and not cur_lim else non_neg_int(cur.get('last_flush_ms')),
                })


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
    if '--deliver' in sys.argv[1:]:
        deliver_queue()
        return

    sync = '--sync' in sys.argv[1:]
    flush = '--flush' in sys.argv[1:]
    if flush and (not sys.stdin or sys.stdin.isatty()):
        raw_stdin = ''
    else:
        raw_stdin = sys.stdin.read(2 * 1024 * 1024) if sys.stdin and not sys.stdin.isatty() else ''

    site, token, chain_cmd, flush_sec = load_config()
    if chain_cmd and raw_stdin:
        run_chain(chain_cmd, raw_stdin)
    if not site or not token:
        return

    if flush and not raw_stdin.strip():
        if sync:
            deliver_queue()
        else:
            subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), '--deliver'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            )
        return

    if not raw_stdin.strip():
        return
    try:
        payload = json.loads(raw_stdin)
    except ValueError:
        return
    if not isinstance(payload, dict):
        return

    dt_now = now_utc()
    new_limits = None
    new_record = None
    agent_state = clean_str(payload.get('agent_state'), 30).lower()

    # 1. Quota / subscription limits (independent of conversation_id)
    limits = parse_quotas(payload.get('quota'), dt_now)
    if limits:
        q_path = os.path.join(STATE_DIR, 'quota.json')
        q_state = load_json(q_path)
        sig = json.dumps([[x['kind'], x['percentUsed'], x.get('resetsAt', '')[:16]] for x in limits])
        if q_state.get('sig') != sig:
            save_json(q_path, {'sig': sig, 'ts': iso_now(dt_now)})
            new_limits = limits

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

        # Persist latest context fill for hooks/activity.py (Stop hook): total context = new input + cache read + cache write
        ctx_tokens = (
            non_neg_int(cu.get('input_tokens'))
            + non_neg_int(cu.get('cache_read_input_tokens'))
            + non_neg_int(cu.get('cache_creation_input_tokens'))
        ) if cu else None
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

            new_input = delta_in_total - cache_read - cache_write if cache_read + cache_write <= delta_in_total else delta_in_total

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

            model_id = normalize_model(model.get('id') or model.get('display_name') or 'unknown')
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
            new_record = otlp_log_record(
                session_id, prompt_id, call_id, dt_now, model_id, effort,
                new_input, delta_out, cache_read, cache_write, duration_ms, cost_micros, query_source, version,
            )

        save_json(st_path, st)

    should_flush = enqueue_work(new_record, new_limits, agent_state, flush_sec, sync or flush)
    if not should_flush:
        return

    if sync:
        deliver_queue()
    else:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), '--deliver'],
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
