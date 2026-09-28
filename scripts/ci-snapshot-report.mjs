// Gom kết quả SnapshotTests (JSON từng fixture) thành bảng Markdown cho GitHub job summary.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const output = process.argv[2] || 'snapshot-output'
const snapshots = JSON.parse(readFileSync('ci-snapshot/snapshots.json', 'utf8'))
const rows = snapshots.map(({ fixture }) => {
  const path = join(output, `${fixture}.json`)
  if (!existsSync(path)) return `| ${fixture} | ⚠️ not rendered | — |`
  const result = JSON.parse(readFileSync(path, 'utf8'))
  if (!result.reference) return `| ${fixture} | rendered (no Figma reference) | — |`
  return `| ${fixture} | ${(result.match * 100).toFixed(1)}% pixels match | ${(result.meanDelta * 100).toFixed(2)}% |`
})
console.log([
  '## Visual fidelity (iOS Simulator vs Figma)',
  '',
  'UIKit-Code output rendered at 1x on the simulator and compared pixel by pixel with the Figma export of the same node',
  '(a pixel matches when every RGB channel is within 16/255). Images are in the `visual-fidelity` artifact.',
  '',
  '| Fixture | Result | Mean channel delta |',
  '| --- | --- | --- |',
  ...rows,
  ''
].join('\n'))
