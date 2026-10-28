// The time step of the main chart: how wide one point is. 0 = every record (one turn per point). Pure.
export type StepRange = 'day' | 'week' | 'month'

export const STEP_CHOICES: Record<StepRange, number[]> = {
  day: [0, 5, 15, 30, 60],
  week: [0, 5, 15, 30, 60, 720, 1440],
  month: [0, 5, 15, 30, 60, 720, 1440],
}

export const DEFAULT_STEPS: Record<StepRange, number> = { day: 60, week: 1440, month: 1440 }

/** The steps the Worker answers by itself (/series); longer ones come from the hourly buckets, 0 from the turns. */
export const SERIES_STEPS = [5, 15, 30]

export const stepRange = (range: string): StepRange | null => (range === 'day' || range === 'week' || range === 'month' ? range : null)

export const stepLabel = (m: number): string => (m === 0 ? 'Кожен запис' : m < 60 ? `${m} хв` : `${m / 60} год`)

/** A saved choice cleaned up: the default when it is not one of the period's steps. */
export const validStep = (range: StepRange, v: unknown): number => (typeof v === 'number' && STEP_CHOICES[range].includes(v) ? v : DEFAULT_STEPS[range])

export const cleanSteps = (saved: unknown): Record<StepRange, number> => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<StepRange, unknown>>
  return { day: validStep('day', s.day), week: validStep('week', s.week), month: validStep('month', s.month) }
}

/** The half-day column an hour falls in: `YYYY-MM-DDT00` for hours 0-11, `YYYY-MM-DDT12` for 12-23. */
export const halfKey = (day: string, hour: number): string => `${day}T${hour < 12 ? '00' : '12'}`
