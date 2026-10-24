// A dropdown that looks like the rest of the page (a native <select> cannot be styled): button, popup list, keyboard and outside click.
import { el } from '../lib/dom.ts'

export interface Option {
  value: string
  label: string
}

export interface Dropdown {
  set(options: Option[], current: string): void
}

/** `root` holds a `.dd-btn` button and a `.dd-menu` list; `onPick` gets the chosen value. */
export function dropdown(root: HTMLElement, onPick: (value: string) => void): Dropdown {
  const btn = root.querySelector<HTMLButtonElement>('.dd-btn')!
  const menu = root.querySelector<HTMLElement>('.dd-menu')!
  const label = btn.querySelector<HTMLElement>('.dd-label')!
  const items = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  const close = (focusBtn = false): void => {
    menu.classList.add('hide')
    btn.setAttribute('aria-expanded', 'false')
    if (focusBtn) btn.focus()
  }
  const open = (): void => {
    menu.classList.remove('hide')
    btn.setAttribute('aria-expanded', 'true')
    ;(items().find(i => i.getAttribute('aria-selected') === 'true') ?? items()[0])?.focus()
  }
  btn.addEventListener('click', () => (menu.classList.contains('hide') ? open() : close()))
  document.addEventListener('pointerdown', e => { if (!root.contains(e.target as Node)) close() })
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(true); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (menu.classList.contains('hide')) { open(); return }
    const list = items(), i = list.indexOf(document.activeElement as HTMLButtonElement)
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  })
  const mark = (value: string, text: string): void => {
    label.textContent = text
    items().forEach(i => i.setAttribute('aria-selected', String(i.dataset.v === value)))
  }
  return {
    set(options, current) {
      menu.replaceChildren(...options.map(o => el('button', {
        type: 'button', role: 'option', 'data-v': o.value, 'aria-selected': 'false',
        onclick: () => { close(true); mark(o.value, o.label); onPick(o.value) },
      }, o.label)))
      mark(options.some(o => o.value === current) ? current : options[0]?.value ?? '', options.find(o => o.value === current)?.label ?? options[0]?.label ?? '')
    },
  }
}
