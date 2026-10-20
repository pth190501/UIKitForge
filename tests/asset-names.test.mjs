import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { addAndroidImageAssets, androidResourceName } from '../src/android-compose.js'

const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
const iconComponent = (id, componentId, x, imageRef) => ({
  id,
  type: 'INSTANCE',
  name: `${componentId} icon`,
  componentId,
  ...box(x, 0, 40, 40),
  children: [{
    id: `I${id};10:1`,
    type: 'RECTANGLE',
    name: 'Icon',
    fills: [{ type: 'IMAGE', imageRef }],
    ...box(x, 0, 24, 24)
  }]
})

const compiled = compileUIKit({
  root: {
    id: '1:1',
    type: 'FRAME',
    name: 'Screen',
    ...box(0, 0, 100, 40),
    children: [iconComponent('1:2', 'first', 0, 'first-image'), iconComponent('1:3', 'second', 50, 'second-image')]
  }
}, 'ScreenView')

const icons = compiled.componentIRs.map(({ className, ir }) => ({
  className,
  node: ir.children.find(node => node.kind === 'image')
}))
assert.deepEqual(icons.map(({ node }) => node.outlet), ['icon', 'icon'])
assert.deepEqual(icons.map(({ node }) => node.assetName || node.outlet), ['icon', 'icon2'])

for (const { className, node } of icons) {
  const assetName = node.assetName || node.outlet
  const swift = compiled.files.find(file => file.target === 'uikit-xib' && file.kind === 'component' && file.name === `${className}.swift`)
  const swiftUI = compiled.swiftUIFiles.find(file => file.kind === 'component' && file.name === `${className}.swift`)
  const android = compiled.androidFiles.find(file => file.kind === 'component' && file.name === `${className}.kt`)
  assert.ok(swift.content.includes(`UIImage(named: "${assetName}")`))
  assert.ok(swiftUI.content.includes(`Image("${assetName}")`))
  assert.ok(android.content.includes(`R.drawable.${androidResourceName(assetName)}`))
}

const packed = new Map()
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) })
  const warnings = await addAndroidImageAssets({ file: (path, data) => packed.set(path, data) }, {
    refs: icons.map(({ node }) => ({ outlet: node.outlet, assetName: node.assetName || node.outlet, figmaId: node.figmaId })),
    nodeImageExports: Object.fromEntries(icons.map(({ node }) => [node.figmaId, {
      '2x': 'https://example.test/2x.png',
      '3x': 'https://example.test/3x.png'
    }]))
  })
  assert.deepEqual(warnings, [])
  for (const { node } of icons) {
    const name = androidResourceName(node.assetName || node.outlet)
    assert.ok(packed.has(`Android/src/main/res/drawable-xhdpi/${name}.png`))
    assert.ok(packed.has(`Android/src/main/res/drawable-xxhdpi/${name}.png`))
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log('✓ cross-component UIKit, SwiftUI and Compose assets stay uniquely named')
