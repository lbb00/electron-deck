import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const banner = await readFile(new URL('../assets/banner.svg', import.meta.url), 'utf8')

test('the dragged source leaves its original tab group', () => {
  assert.match(banner, /class="sourceTab"/)
  assert.match(banner, /@keyframes sourceTab[\s\S]*?opacity:\s*0/)
})

test('a dock creates a full-height panel below the native modal', () => {
  const panelMatch = banner.match(
    /<g class="dockedPanel"[\s\S]*?<polygon data-role="panel-shell" points="([^"]+)"/,
  )
  assert.ok(panelMatch, 'expected a persistent docked panel')

  const points = panelMatch[1].split(' ').map((point) => point.split(',').map(Number))
  const yValues = points.map(([, y]) => y)
  assert.ok(Math.max(...yValues) - Math.min(...yValues) >= 140, 'docked panel must span the target height')

  assert.ok(
    banner.indexOf('class="dockedPanel"') < banner.indexOf('<g class="ov">'),
    'the z2 modal must be painted after the docked panel',
  )
})

test('the z2 popup identifies itself inside the animation', () => {
  const overlayStart = banner.indexOf('<g class="ov">')
  const overlayEnd = banner.indexOf('<!-- Dock helpers', overlayStart)
  const overlay = banner.slice(overlayStart, overlayEnd)

  assert.match(overlay, />Native overlay</)
  assert.match(overlay, />WebContentsView</)
})

test('the complete animation takes no longer than eight seconds', () => {
  const durations = [...banner.matchAll(/animation:\s*[\w-]+\s+([\d.]+)s/g)].map((match) => Number(match[1]))
  assert.ok(durations.length > 0)
  assert.ok(Math.max(...durations) <= 8)
})
