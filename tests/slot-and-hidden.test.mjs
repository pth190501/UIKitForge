import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { feedSlotScreen } from './fixtures.mjs'

const compiled = compileUIKit(feedSlotScreen, 'GeneratedView', { deploymentTarget: 13 })

const labelTexts = []
const walk = node => {
  if (node.kind === 'label') labelTexts.push(node.text)
  for (const child of node.children || []) walk(child)
}
walk(compiled.previewRoot)

// SLOT (Figma Slots) phải được dựng như container — trước fix cả 2 slot Header/Content bị bỏ, mất hết label.
for (const text of ['Emi bảo trì', '20/04/2026', 'Emi báo lịch bảo trì mạng hôm nay', 'Khu vực Long Biên tạm ngưng kết nối.']) {
  assert.ok(labelTexts.includes(text), `label "${text}" should be compiled from inside a SLOT`)
}
const mainXib = compiled.files.find(file => file.path === 'GeneratedView/GeneratedView.xib').content
assert.match(mainXib, /text="Emi bảo trì"/)
assert.match(mainXib, /customClass="EmiAvatarView"/, 'component inside a SLOT should be placed in the main XIB')
assert.ok(!compiled.warnings.some(w => w.includes('SLOT')), 'SLOT is a known type and should not warn')

// Instance ẩn (Ellipsis-horizontal visible:false) không được sinh class component thừa.
const componentNames = compiled.components.map(c => c.className)
assert.ok(componentNames.includes('EmiAvatarView'))
assert.ok(!componentNames.includes('EllipsisHorizontalView'), 'hidden instance must not produce a component class')
assert.ok(!compiled.files.some(file => file.path.includes('EllipsisHorizontal')), 'no files for hidden components')
assert.ok(!compiled.swiftUIFiles.some(file => file.path.includes('EllipsisHorizontal')), 'no SwiftUI files for hidden components')

// Node type Figma chưa biết nhưng có con: giữ nhánh + cảnh báo, không bỏ im lặng.
const future = compileUIKit({
  root: {
    id: '9:1', type: 'FRAME', name: 'Screen', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
    children: [{
      id: '9:2', type: 'SOME_FUTURE_CONTAINER', name: 'Wrapper', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 40 },
      children: [{ id: '9:3', type: 'TEXT', name: 'Hello', characters: 'Hello', style: { fontSize: 14 }, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 } }]
    }]
  }
}, 'FutureView', { deploymentTarget: 13 })
assert.match(future.files.find(file => file.path === 'FutureView/FutureView.xib').content, /text="Hello"/)
assert.ok(future.warnings.some(w => w.includes('SOME_FUTURE_CONTAINER')), 'unknown container type should produce a warning')

// Root ẩn (URL trỏ thẳng vào node ẩn) vẫn gom component bên trong.
const hiddenRoot = structuredClone(feedSlotScreen)
hiddenRoot.root.visible = false
assert.ok(compileUIKit(hiddenRoot, 'GeneratedView', { deploymentTarget: 13 }).components.some(c => c.className === 'EmiAvatarView'))

console.log('✓ SLOT containers, unknown container types, hidden-instance components passed')
