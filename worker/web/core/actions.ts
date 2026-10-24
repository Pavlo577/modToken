// Hooks that the controls fill in, so the data and tab modules can ask for a redraw without importing the controls.

export const actions = {
  render: (): void => {},
  syncControls: (): void => {},
  setDevices: (_names: string[]): void => {},
}
