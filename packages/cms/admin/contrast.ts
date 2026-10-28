// WCAG's contrast ratio between two #rrggbb colours
export function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = hex.match(/\w\w/g)!.map((pair) => {
      const channel = parseInt(pair, 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

const surfaces = ['--cms-page', '--cms-surface', '--cms-subtle']
const texts = ['--cms-text', '--cms-muted', '--cms-accent-strong', '--cms-danger', '--cms-success', '--cms-warning']

// The theme's colour pairs and the ratio each needs in both modes: 4.5:1 for text, and 3:1 for the edges of controls.
// test/theme.test.ts checks them, and the reference page shows them.
export const pairs: Array<[foreground: string, background: string, minimum: number]> = [
  ...texts.flatMap((text) => surfaces.map((surface): [string, string, number] => [text, surface, 4.5])),
  ['--cms-text', '--cms-accent-tint', 4.5],
  ['--cms-accent-strong', '--cms-accent-tint', 4.5],
  ['--cms-on-accent', '--cms-accent', 4.5],
  ['--cms-on-accent', '--cms-accent-hover', 4.5],
  ['--cms-on-danger', '--cms-danger', 4.5],
  ...['danger', 'success', 'warning'].flatMap((tone): Array<[string, string, number]> => [
    ['--cms-text', `--cms-${tone}-tint`, 4.5],
    [`--cms-${tone}`, `--cms-${tone}-tint`, 4.5],
  ]),
  ['--cms-border', '--cms-page', 3],
  ['--cms-border', '--cms-surface', 3],
]
