// Colours: the series palette and a stable colour for every device ever seen.

export const PALETTE = ['#ff7a1a', '#3d8bff', '#9b7bff', '#35c98c', '#ffc24a', '#ff5d8f', '#6fd3e8']

/** Every device ever seen here, so a device keeps its colour whatever period is shown. */
const seenDevices: string[] = (() => {
  try { return (JSON.parse(localStorage.getItem('tt-devices') || '[]') as string[]).filter(n => typeof n === 'string') } catch { return [] }
})()

export const rememberDevices = (names: string[]): void => {
  const before = seenDevices.length
  for (const n of names) if (!seenDevices.includes(n)) seenDevices.push(n)
  seenDevices.sort()
  if (seenDevices.length !== before) { try { localStorage.setItem('tt-devices', JSON.stringify(seenDevices)) } catch { /* ignore */ } }
}

export const devColor = (name: string): string => PALETTE[Math.max(0, seenDevices.indexOf(name)) % PALETTE.length]
