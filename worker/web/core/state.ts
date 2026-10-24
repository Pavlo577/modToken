// The dashboard state (what the viewer chose), kept in localStorage; the open tab also lives in the address.

export type Tab = 'overview' | 'analytics' | 'money' | 'sessions' | 'devices'

export type View = 'line' | 'bars' | 'cal'

type Metric = 'io' | 'all' // 'all' adds the cache reads

/** Which of the two to draw: both, only input (arrow down) or only output (arrow up). */
export type IoMode = 'both' | 'in' | 'out'

export const IO_NEXT: Record<IoMode, IoMode> = { both: 'in', in: 'out', out: 'both' }

interface State {
  tab: Tab
  range: string // 'today' | 'week' | 'month' | 'year' | 'custom'
  /** A day inside the shown week / month / year; '' means today. Not saved. */
  anchor: string
  /** Year view of the activity card: month tiles or month calendars; '' = by length of the period. */
  actMode: '' | 'min' | 'detail'
  /** Activity card: colour each cell by the device that used the most (all devices only). */
  topDevice: boolean
  from: string
  to: string
  device: string
  /** Only this agent (claude, codex ...); '' = all of them. */
  provider: string
  view: View
  metric: Metric
  io: IoMode
  /** Input and output hidden altogether (the cache can stay). */
  ioHidden: boolean
  /** Main chart: one line / stack per agent on the same scale (input + output added up). */
  compare: boolean
  /** Main chart: the value axis is fitted to the largest value of the whole period (all agents, all devices) and stays put when the choices change. */
  fixedScale: boolean
  /** Main chart with the cache on: 'log' = logarithmic, 'linear' = one linear scale, cache clipped at the top. */
  scale: 'log' | 'linear'
  day: string
}

let saved: Partial<State> = {}
try { saved = JSON.parse(localStorage.getItem('tt-state') || '{}') as Partial<State> } catch { /* private mode: start with defaults */ }

const OLD_RANGES: Record<string, string> = { '7': 'week', '30': 'month', '90': 'month', '365': 'year' }

const TABS: Tab[] = ['overview', 'analytics', 'money', 'sessions', 'devices']

export const asTab = (v: unknown): Tab | null => (TABS as unknown[]).includes(v) ? (v as Tab) : null

// the tab survives a reload: the address (#analytics) wins, then the last one used
const startTab: Tab = asTab(location.hash.slice(1)) ?? asTab((saved as { tab?: unknown }).tab) ?? 'overview'

export const state: State = { range: 'month', from: '', to: '', device: '', provider: '', view: 'line', metric: 'io', io: 'both', ioHidden: false, compare: false, fixedScale: false, scale: 'log', day: '', actMode: '', topDevice: false, ...saved, anchor: '', tab: startTab }

state.range = OLD_RANGES[state.range] ?? state.range

if ((state.io as string) === 'off') { state.io = 'both'; state.ioHidden = true } // the old fourth mode

if (!(state.io in IO_NEXT)) state.io = 'both'

if (state.metric !== 'all') state.metric = 'io' // the old 'cost' choice is gone

export const persist = (): void => {
  try { localStorage.setItem('tt-state', JSON.stringify({ range: state.range, from: state.from, to: state.to, device: state.device, provider: state.provider, view: state.view, metric: state.metric, io: state.io, ioHidden: state.ioHidden, compare: state.compare, fixedScale: state.fixedScale, scale: state.scale, actMode: state.actMode, topDevice: state.topDevice, tab: state.tab })) } catch { /* ignore */ }
}
