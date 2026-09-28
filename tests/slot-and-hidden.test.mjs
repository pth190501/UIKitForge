import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { foldDiacritics } from '../src/identifier.js'
import { feedSlotScreen } from './fixtures.mjs'

const compiled = compileUIKit(feedSlotScreen, 'GeneratedView', { deploymentTarget: 13 })

const labelTexts = []
const walk = node => {
  if (node.kind === 'label') labelTexts.push(node.text)
  for (const child of node.children || []) walk(child)
}
walk(compiled.previewRoot)

// SLOT (Figma Slots) phải được dựng như container — trước fix cả 2 slot Header/Content bị bỏ, mất hết label.
for (const text of ['Emi bảo trì', '20/04/2026', 'Emi báo lịch bảo trì mạng hôm nay', 'Khu vực Long Biên sẽ tạm ngưng kết nối Internet để nâng cấp hạ tầng. Dự kiến hoàn thành sau 30 phút.']) {
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

// Tên outlet từ layer tiếng Việt: bỏ dấu thay vì xoá ký tự (trước: `emiBOTr`, `emiBOLChBOTrMNgHMNay`).
const outlets = []
const collectOutlets = node => { outlets.push(node.outlet); for (const child of node.children || []) collectOutlets(child) }
collectOutlets(compiled.previewRoot)
for (const outlet of ['emiBaoTri', 'emiBaoLichBaoTriMangHomNay', 'khuVucLongBienSeTamNgungKetNoi']) {
  assert.ok(outlets.includes(outlet), `outlet ${outlet} expected, got ${outlets.join(', ')}`)
}
assert.match(compiled.files.find(file => file.path === 'GeneratedView/GeneratedView.swift').content, /@IBOutlet private weak var emiBaoTri: UILabel!/)
assert.equal(foldDiacritics('Đặt lịch đi'), 'Dat lich di')

// Tên outlet lấy từ cả câu text vẫn phải ≤ 40 ký tự (SwiftLint identifier_name, CI chạy --strict).
for (const outlet of outlets) assert.ok(outlet.length <= 40, `outlet ${outlet} is ${outlet.length} chars (> 40)`)

// TEXT: fill của Figma là màu chữ, không được thành backgroundColor (trước fix label thành khối đặc cùng màu chữ).
const labelNodes = []
const collectLabels = node => { if (node.kind === 'label') labelNodes.push(node); for (const child of node.children || []) collectLabels(child) }
collectLabels(compiled.previewRoot)
for (const label of labelNodes) {
  assert.equal(label.style.background, null, `${label.outlet}: label must not get its text color as background`)
  assert.ok(label.style.textColor, `${label.outlet}: label keeps its text color`)
}
for (const path of ['GeneratedView/GeneratedView.swift', 'UIKit-Code/GeneratedView/GeneratedView.swift']) {
  assert.doesNotMatch(compiled.files.find(file => file.path === path).content, /emiBaoTri\.backgroundColor/, `${path}: label must not set backgroundColor`)
}
assert.doesNotMatch(mainXib.split('text="Emi bảo trì"')[1].split('</label>')[0], /key="backgroundColor"/, 'XIB label must not set backgroundColor')

// Câu text dài: tắt line_length đúng dòng đó thay vì để SwiftLint fail.
assert.match(compiled.files.find(file => file.path === 'GeneratedView/GeneratedView.swift').content,
  /\/\/ swiftlint:disable:next line_length\n\s+khuVucLongBienSeTamNgungKetNoi\.text = "Khu vực/)

console.log('✓ SLOT containers, unknown container types, hidden-instance components, Vietnamese outlet names, label colors passed')
