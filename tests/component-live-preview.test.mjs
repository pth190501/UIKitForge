import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'

const figmaData = {
  root: {
    id: '1:1',
    type: 'FRAME',
    name: 'Demo Screen',
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        id: '2:1',
        type: 'INSTANCE',
        componentId: 'component-card',
        name: 'Package Card',
        cornerRadius: 12,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
        absoluteBoundingBox: { x: 16, y: 100, width: 358, height: 120 },
        constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' },
        children: [
          {
            id: '2:2',
            type: 'TEXT',
            name: 'Title',
            characters: 'Fast Data',
            fills: [{ type: 'SOLID', color: { r: 0.05, g: 0.05, b: 0.05, a: 1 } }],
            style: { fontSize: 16, fontWeight: 600, textAutoResize: 'HEIGHT' },
            absoluteBoundingBox: { x: 32, y: 116, width: 160, height: 24 },
            constraints: { horizontal: 'LEFT', vertical: 'TOP' }
          }
        ]
      }
    ]
  }
}

const compiled = compileUIKit(figmaData, 'DemoView')
const componentSwift = compiled.files.find(file => file.kind === 'component' && file.language === 'swift')
assert.ok(componentSwift, 'component Swift file should be generated')

const componentNode = compiled.previewRoot.children.find(node => node.kind === 'component')
assert.ok(componentNode, 'parent preview should contain the generated component')
assert.equal(componentNode.style.radius, 12)
assert.equal(componentNode.previewChildren?.[0]?.text, 'Fast Data')

componentSwift.content = componentSwift.content
  .replace('contentView.layer.cornerRadius = 12', 'contentView.layer.cornerRadius = 30')
  .replace('title.text = "Fast Data"', 'title.text = "Edited live"')

assert.equal(componentNode.style.radius, 30, 'editing component Swift should update the component instance in parent preview')
assert.equal(componentNode.previewChildren?.[0]?.text, 'Edited live', 'editing a component label should update its parent preview content')

console.log('✓ component Swift edits propagate to parent Browser Preview')
