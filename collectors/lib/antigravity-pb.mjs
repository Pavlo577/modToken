// Antigravity CLI keeps each conversation in a SQLite file whose rows hold protobuf blobs. This reads ONLY the numeric fields
// the tracker needs (token counts, times, ids, the model name) out of the `steps.metadata` and `gen_metadata.data` blobs.
// Every other field is skipped without being decoded into a value, and nothing here ever sees `steps.step_payload` (the content).
// The field numbers were read off a real install and are not documented by Google: see collectors/DATA.md, section "Antigravity".

const MAX_SAFE = Number.MAX_SAFE_INTEGER

/** The fields of one protobuf message as [{ f, w, v }] (v: a number for varints, bytes for length-delimited), or null if it is not valid. */
export function readFields(buf) {
  if (!(buf instanceof Uint8Array) || !buf.length) return null
  const out = []
  let i = 0
  const varint = () => {
    let r = 0, scale = 1
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw new Error('eof')
      const x = buf[i++]
      r += (x & 0x7f) * scale
      if (!(x & 0x80)) return r
      scale *= 128
    }
    throw new Error('varint')
  }
  try {
    while (i < buf.length) {
      const key = varint(), f = Math.floor(key / 8), w = key % 8
      if (!f) return null
      if (w === 0) out.push({ f, w, v: varint() })
      else if (w === 1) { i += 8; if (i > buf.length) return null; out.push({ f, w, v: 0 }) }
      else if (w === 5) { i += 4; if (i > buf.length) return null; out.push({ f, w, v: 0 }) }
      else if (w === 2) {
        const len = varint()
        if (i + len > buf.length) return null
        out.push({ f, w, v: buf.subarray(i, i + len) })
        i += len
      } else return null
    }
  } catch { return null }
  return out
}

const first = (fields, f, w) => fields?.find(x => x.f === f && (w === undefined || x.w === w))?.v
const num = (fields, f) => { const v = first(fields, f, 0); return typeof v === 'number' && v >= 0 && v <= MAX_SAFE ? v : 0 }
const sub = (fields, f) => { const v = first(fields, f, 2); return v ? readFields(v) : null }
const text = (fields, f, re, max = 200) => {
  const v = first(fields, f, 2)
  if (!v || !v.length || v.length > max) return ''
  const s = Buffer.from(v).toString('utf8')
  return re.test(s) ? s : ''
}

const ID = /^[A-Za-z0-9._:-]{1,200}$/
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/

/** A google.protobuf.Timestamp { 1: seconds, 2: nanos } as milliseconds since the epoch, or 0 when it does not look like a recent time. */
function time(fields, f) {
  const t = sub(fields, f)
  const sec = num(t, 1)
  if (sec < 1.5e9 || sec > 4.1e9) return 0
  return sec * 1000 + Math.floor(num(t, 2) / 1e6)
}

/**
 * The token block (`ModelUsageStats`): 2 input WITHOUT cache, 3 output (= 9 thinking + 10 answer), 4 cache written, 5 cache read,
 * 7 id of the model response. Null when the message carries no tokens.
 */
function usage(fields) {
  if (!fields) return null
  const u = { input: num(fields, 2), output: num(fields, 3), cacheWrite: num(fields, 4), cacheRead: num(fields, 5), reasoning: num(fields, 9), message: text(fields, 7, ID) }
  return u.input || u.output || u.cacheRead || u.cacheWrite ? u : null
}

/**
 * One `steps.metadata` blob: when the step was created / started / ended, the id of the turn it belongs to (field 12: the same for
 * the user's input and every model response until the next input), and the tokens if it is a model response.
 */
export function readStep(blob) {
  const m = readFields(blob)
  if (!m) return null
  const ids = sub(m, 20)
  return {
    created: time(m, 1), started: time(m, 6), ended: time(m, 7),
    turn: text(m, 12, ID),
    trajectory: text(ids, 1, ID), conversation: text(ids, 4, ID),
    usage: usage(sub(m, 9)),
  }
}

/** One `gen_metadata.data` blob: the response id and the model name, so a step's tokens get a model. */
export function readGeneration(blob) {
  const m = readFields(blob)
  if (!m) return null
  const g = sub(m, 1)
  const u = sub(g, 4)
  return { turn: text(m, 4, ID), message: text(u, 7, ID), model: text(g, 19, MODEL) }
}
