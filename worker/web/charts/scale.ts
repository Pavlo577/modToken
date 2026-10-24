// Value-axis maths: round maxima, ticks, logarithmic axis, smooth curves, heat levels.

/** Axis maximum: the smallest of 1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8 times a power of ten that holds v (so a quarter of it is a round step too). */
export const niceMax = (v: number): number => {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const f = v / p
  return ([1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find(n => f <= n + 1e-9) ?? 10) * p
}

export const ticks = (max: number, n = 4): number[] => Array.from({ length: n + 1 }, (_, i) => (max / n) * i)

/** Monotone cubic path through points, so the curve never overshoots the data. */
export function smooth(pts: [number, number][]): string {
  const n = pts.length
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`
  if (n === 2) return `M${pts[0][0]},${pts[0][1]}L${pts[1][0]},${pts[1][1]}`
  const dx: number[] = [], m: number[] = [], t: number[] = []
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i] }
  t[0] = m[0]; t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    d += `C${pts[i][0] + dx[i] / 3},${pts[i][1] + (t[i] * dx[i]) / 3},${pts[i + 1][0] - dx[i] / 3},${pts[i + 1][1] - (t[i + 1] * dx[i]) / 3},${pts[i + 1][0]},${pts[i + 1][1]}`
  }
  return d
}

/** Indexes of the category labels to print so that they do not overlap. */
export const evenLabels = (n: number, width: number, minGap = 64): number[] => {
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / minGap))))
  const idx = Array.from({ length: n }, (_, i) => i).filter(i => i % every === 0)
  // always end on the last category, moving the previous label there when the two would touch
  if (idx.length && idx[idx.length - 1] !== n - 1) {
    if (n - 1 - idx[idx.length - 1] >= every * 0.9) idx.push(n - 1)
    else idx[idx.length - 1] = n - 1
  }
  return idx
}

/** Largest "nice" number (1, 2, 2.5, 5 times a power of ten) that does not exceed v. */
const niceFloor = (v: number): number => {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const f = v / p
  return (f >= 5 ? 5 : f >= 2.5 ? 2.5 : f >= 2 ? 2 : 1) * p
}

/**
 * Value-axis maximum when an extra series (the cache) shares the scale: fitted to the main series, so that its highest
 * point reaches at least the first grid line; the extra series is clipped at the top if it is larger.
 */
export function sharedMax(mainMax: number, extraMax: number): number {
  const full = niceMax(Math.max(mainMax, extraMax))
  return Math.max(niceMax(mainMax), Math.min(full, niceFloor(4 * mainMax)))
}

/** Logarithmic value axis: one gridline per power of ten that spans all the values; zero sits on the bottom line. */
export function logAxis(values: number[], top: number, ih: number): { ticks: number[]; y: (v: number) => number } {
  const pos = values.filter(v => v > 0)
  const lo = Math.floor(Math.log10(Math.min(...pos))), hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...pos))))
  return {
    ticks: Array.from({ length: hi - lo + 1 }, (_, k) => 10 ** (lo + k)),
    y: v => top + ih - ((Math.log10(Math.max(v, 10 ** lo)) - lo) / (hi - lo)) * ih,
  }
}

/** Heat level 0-4 for each value: quartiles of the non-zero ones, so a few huge days do not wash out the rest. */
export function levels(values: number[]): (v: number) => number {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  const q = (p: number): number => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]
  const cuts = nz.length ? [q(0.25), q(0.5), q(0.75)] : [0, 0, 0]
  return v => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4)
}
