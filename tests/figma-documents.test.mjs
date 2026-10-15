import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { componentPropertiesScreen } from './fixtures.mjs'

const sourceChildren = componentPropertiesScreen.root.children
const clone = value => JSON.parse(JSON.stringify(value))
const data = {
  source: { fileKey: 'exampleFile', nodeId: '6:1' },
  components: {},
  componentSets: {},
  styles: {},
  root: {
    ...componentPropertiesScreen.root,
    children: [
      {
        id: '6:7', type: 'FRAME', name: 'Services | quick actions', layoutMode: 'HORIZONTAL', itemSpacing: 8,
        absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 48 },
        children: sourceChildren.slice(0, 3).map(clone)
      },
      {
        id: '6:8', type: 'FRAME', name: 'Purchase', absoluteBoundingBox: { x: 0, y: 52, width: 390, height: 52 },
        reactions: [{ trigger: { type: 'ON_CLICK' }, action: { type: 'NODE', destinationId: '6:9' } }],
        children: sourceChildren.slice(3).map(clone)
      },
      { id: '6:10', type: 'FRAME', name: 'Vibe Club', visible: false, absoluteBoundingBox: { x: 0, y: 108, width: 390, height: 40 } },
      {
        id: '6:11', type: 'SLOT', name: 'Configured services', layoutMode: 'HORIZONTAL', itemSpacing: 8,
        absoluteBoundingBox: { x: 0, y: 160, width: 390, height: 48 },
        children: [{ id: '6:12', type: 'TEXT', name: 'Service sample', characters: 'Service', style: { fontSize: 14 }, absoluteBoundingBox: { x: 0, y: 160, width: 60, height: 20 } }]
      }
    ]
  }
}

const compiled = compileUIKit(data, 'HomeView')
const manifest = compiled.files.find(file => file.path === 'FIGMA_UI_MANIFEST.md')?.content
const progress = compiled.files.find(file => file.path === 'FIGMA_IMPLEMENTATION_PROGRESS.md')?.content

assert.ok(manifest)
assert.ok(progress)
assert.match(manifest, /https:\/\/www\.figma\.com\/design\/exampleFile\?node-id=6-1/)
assert.match(manifest, /Services \\| quick actions/)
assert.match(manifest, /Repeated instances: TagView × 3; sample views stay fixed as drawn/)
assert.match(manifest, /Vibe Club.*6:10.*FRAME/)
assert.match(manifest, /ON_CLICK.*NODE → 6:9/)
assert.match(manifest, /Button.*Primary/)
assert.match(manifest, /Configured services.*6:11.*HomeView\.configuredServices.*TODO: bind app data; keep Figma sample views and layout/)
assert.match(progress, /Native build \/ XIB validation: NOT VERIFIED/)
assert.match(progress, /Configuration TODOs: GENERATED at visible Figma slots; sample views and layout remain fixed to the design/)
assert.match(progress, /Simulator\/device rendering: NOT VERIFIED/)
assert.doesNotMatch(progress, /Section status[\s\S]*\| DONE \|/)

console.log('✓ Figma manifest and implementation checkpoint passed')
