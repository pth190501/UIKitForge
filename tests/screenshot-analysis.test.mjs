import assert from 'node:assert/strict'
import { buildScreenshotFigmaData } from '../src/screenshot.js'

const data = buildScreenshotFigmaData({
  width: 390,
  height: 844,
  filename: 'screen.png',
  ocrEngine: 'test',
  background: { r: 1, g: 1, b: 1, a: 1 },
  regions: [
    { x: 16, y: 100, width: 358, height: 120, role: 'container', color: { r: .95, g: .96, b: 1, a: 1 }, radius: 16 },
    { x: 20, y: 700, width: 350, height: 52, role: 'button', color: { r: .1, g: .3, b: .9, a: 1 } }
  ],
  textLines: [
    { text: 'Fast Data', x: 32, y: 118, width: 160, height: 24, fontSize: 18 },
    { text: 'Continue', x: 150, y: 716, width: 90, height: 20, fontSize: 15 }
  ]
})

assert.equal(data.source.mode, 'screenshot')
assert.equal(data.root.absoluteBoundingBox.width, 390)
assert.equal(data.root.children.length, 2)
assert.equal(data.root.children[0].children[0].characters, 'Fast Data')
assert.equal(data.root.children[1].children[0].characters, 'Continue')
assert.equal(data.root.children[1].constraints.horizontal, 'LEFT_RIGHT')
assert.ok(data.analysisWarnings.some(item => item.includes('Image-only mode')))

console.log('✓ screenshot-only hierarchy generation passed')
