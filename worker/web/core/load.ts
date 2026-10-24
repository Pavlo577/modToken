// Loads the data of the shown period (with grey placeholders when it is slow) and hands it to the tabs.
import { $, el, skeleton, skeletonTile } from '../lib/dom.ts'
import type { Bucket, SessionRow } from '../lib/types.ts'
import { SKELETON_AFTER_MS, mainHeight } from '../ui/layout.ts'
import { actions } from './actions.ts'
import { rememberDevices } from './palette.ts'
import { currentRange } from './range.ts'
import { state } from './state.ts'
import { get, q, store } from './store.ts'

export async function load(): Promise<void> {
  // placeholders only if loading is slow; a quick load goes straight to the charts
  const slow = setTimeout(() => {
    $('kpis').replaceChildren(...Array.from({ length: 6 }, skeletonTile))
    for (const [id, h] of [['main-chart', mainHeight()], ['day-chart', 200], ['hour-grid', 200], ['cache-chart', 200], ['cost-chart', 220]] as const) skeleton($(id), h)
  }, SKELETON_AFTER_MS)
  const r = currentRange()
  const histFrom = r.prevFrom
  try {
    const [buckets, sessions] = await Promise.all([
      get<Bucket[]>('/buckets?' + q(histFrom, r.to)),
      get<SessionRow[]>('/sessions?' + q(r.from, r.to)),
    ])
    clearTimeout(slow)
    store.data = { r, buckets, sessions }
    const names = [...new Set(buckets.map(b => b.device))].sort()
    store.deviceNames = names
    rememberDevices(names)
    if (state.device && !names.includes(state.device)) state.device = ''
    actions.setDevices(names)
    const providers = [...new Set(buckets.map(b => b.provider || 'claude'))].sort()
    store.providers = providers
    if (state.provider && !providers.includes(state.provider)) state.provider = ''
    actions.setProviders(providers)
    actions.syncControls()
    actions.render()
  } catch (e) {
    clearTimeout(slow)
    $('kpis').replaceChildren(el('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Не вдалося завантажити: ' + (e as Error).message))
  }
}
