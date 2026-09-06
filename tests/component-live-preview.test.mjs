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

const layoutAwareData = {
  root: {
    id: '31775:52174',
    type: 'FRAME',
    name: 'Target Node',
    layoutMode: 'VERTICAL',
    itemSpacing: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 20,
    paddingBottom: 20,
    absoluteBoundingBox: { x: 100, y: 100, width: 390, height: 300 },
    children: [
      {
        id: '31775:52175',
        type: 'FRAME',
        name: 'Image Card',
        layoutMode: 'NONE',
        fills: [{ type: 'IMAGE', imageRef: 'abc' }],
        absoluteBoundingBox: { x: 116, y: 120, width: 358, height: 120 },
        children: [{
          id: '31775:52176',
          type: 'TEXT',
          name: 'Title',
          characters: 'Preserve me',
          style: { fontSize: 16, fontWeight: 600, textAutoResize: 'HEIGHT' },
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          absoluteBoundingBox: { x: 132, y: 136, width: 140, height: 24 }
        }]
      },
      {
        id: '31775:52177',
        type: 'RECTANGLE',
        name: 'Leaf Image',
        fills: [{ type: 'IMAGE', imageRef: 'def' }],
        absoluteBoundingBox: { x: 116, y: 252, width: 358, height: 28 }
      }
    ]
  }
}

const layoutCompiled = compileUIKit(layoutAwareData, 'TargetView')
const [imageContainer, leafImage] = layoutCompiled.previewRoot.children
assert.equal(imageContainer.kind, 'view', 'image-filled containers must keep their child hierarchy')
assert.equal(imageContainer.children.length, 1, 'image-filled container children must not be dropped')
assert.equal(imageContainer.children[0].kind, 'label')
assert.equal(leafImage.kind, 'image', 'leaf image fills should still map to UIImageView')
assert.ok(
  leafImage.constraints.some(item => item.type === 'topToBottom' && item.targetFigmaId === '31775:52175'),
  'vertical Figma Auto Layout should become sibling-to-sibling XIB constraints'
)

const targetXib = layoutCompiled.files.find(file => file.name === 'TargetView.xib')?.content || ''
assert.match(targetXib, /<label[^>]+text="Preserve me"/)
assert.match(targetXib, /firstAttribute="top" secondItem="UF-3177552175" secondAttribute="bottom" constant="12"/)
assert.ok(layoutCompiled.warnings.some(item => item.includes('preserved its child hierarchy')))

const componentSetCompiled = compileUIKit({ root: {
  id: '9:1',
  type: 'COMPONENT_SET',
  name: 'Button Set',
  absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 80 },
  children: [
    { id: '9:2', type: 'COMPONENT', name: 'State=Default', absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 44 }, children: [] },
    { id: '9:3', type: 'COMPONENT', name: 'State=Pressed', absoluteBoundingBox: { x: 140, y: 0, width: 120, height: 44 }, children: [] }
  ]
}}, 'ButtonView')

assert.equal(componentSetCompiled.sourceRoot.id, '9:2', 'component sets should compile a variant, not every variant at once')
assert.ok(componentSetCompiled.warnings.some(item => item.includes('first visible variant')))

console.log('✓ component live preview + layout-aware compiler regressions passed')
