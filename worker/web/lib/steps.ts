// The time step of the main chart: how wide one point is, in minutes: 60, 720 (12 h) or 1440 (24 h), or 0 = every record (one turn per point). Pure.
export type StepRange = 'day' | 'week' | 'month' | 'custom'

export const STEP_CHOICES: Record<StepRange, number[]> = {
  day: [0, 60],
  week: [0, 60, 720, 1440],
  month: [0, 60, 720, 1440],
  custom: [0, 60, 720, 1440],
}

export const DEFAULT_STEPS: Record<StepRange, number> = { day: 60, week: 1440, month: 1440, custom: 1440 }

/** The steps offered for a period; a single custom day has no 12 and 24 hour steps (the others do not depend on the length). */
export function stepChoices(range: StepRange, spanDays = 31): number[] {
  if (range === 'custom' && spanDays <= 1) return [0, 60]
  return STEP_CHOICES[range]
}

/** The step to draw: the saved choice when the period still offers it, otherwise the period's default (a single custom day is hourly). */
export function effectiveStep(range: StepRange, saved: unknown, spanDays = 31): number {
  const ok = stepChoices(range, spanDays)
  if (typeof saved === 'number' && ok.includes(saved)) return saved
  return range === 'custom' && spanDays <= 1 ? 60 : DEFAULT_STEPS[range]
}

export const stepRange = (range: string): StepRange | null => (range === 'day' || range === 'week' || range === 'month' || range === 'custom' ? range : null)

export const stepLabel = (m: number): string => (m === 0 ? 'Кожен запис' : m < 60 ? `${m} хв` : `${m / 60} год`)

/** A saved choice cleaned up: the default when it is not one of the period's steps (for an interval of your own: of any length). */
export const validStep = (range: StepRange, v: unknown): number => (typeof v === 'number' && STEP_CHOICES[range].includes(v) ? v : DEFAULT_STEPS[range])

export const cleanSteps = (saved: unknown): Record<StepRange, number> => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<StepRange, unknown>>
  return { day: validStep('day', s.day), week: validStep('week', s.week), month: validStep('month', s.month), custom: validStep('custom', s.custom) }
}

/** The half-day column an hour falls in: `YYYY-MM-DDT00` for hours 0-11, `YYYY-MM-DDT12` for 12-23. */
export const halfKey = (day: string, hour: number): string => `${day}T${hour < 12 ? '00' : '12'}`
