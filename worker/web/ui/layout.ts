// Sizes and tiny helpers used by several parts of the page.

/** How long loading may take before grey placeholders appear instead of the old charts. */
export const SKELETON_AFTER_MS = 250

/** Height of the main chart, close to the calendar's: about a quarter of the window, between 200 and 300 px. */
export const mainHeight = (): number => Math.round(Math.min(300, Math.max(200, window.innerHeight * 0.26)))

export const press = (group: HTMLElement, attr: string, value: string): void =>
  group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)))

export const clicked = (e: Event): HTMLButtonElement | null => (e.target as HTMLElement).closest('button')
