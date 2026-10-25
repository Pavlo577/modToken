// Draws the open tab from the loaded data.
import { state } from '../core/state.ts'
import { aggregate, store } from '../core/store.ts'
import { offsetText, tz } from '../core/time.ts'
import { $ } from '../lib/dom.ts'
import { renderAnalytics } from '../tabs/analytics.ts'
import { renderInsights } from '../tabs/insights.ts'
import { renderCost } from '../tabs/money.ts'
import { renderDay, renderKpis, renderMain } from '../tabs/overview.ts'
import { renderSessions } from '../tabs/sessions.ts'
import { press } from './layout.ts'

export function render(): void {
  if (!store.data) return
  const agg = aggregate()
  $('tzchip').textContent = `${tz.tz} · UTC${offsetText()}`
  $('dev-mode').classList.toggle('hide', !(state.tab === 'analytics' && !state.device && store.deviceNames.length > 1))
  press($('dev-mode'), 't', state.topDevice ? 'top' : '')
  if (state.tab === 'overview') { renderKpis(agg); renderMain(agg); void renderDay() }
  else if (state.tab === 'analytics') renderAnalytics(agg)
  else if (state.tab === 'insights') void renderInsights()
  else if (state.tab === 'money') renderCost(agg)
  else if (state.tab === 'sessions') renderSessions(agg)
}
