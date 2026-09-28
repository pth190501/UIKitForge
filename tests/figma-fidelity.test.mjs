import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { isRasterCandidate } from '../src/figma.js'
import { LINT_CONFIG_FILES } from '../src/lint-config.js'

// Node "khó" kiểu màn 34715:42593: icon vector, nền gradient, text đậm một đoạn, bo góc có/không clip, effect lạ.
const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
const stop = (position, r, g, b) => ({ position, color: { r, g, b, a: 1 } })
const screen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Promo', ...box(0, 0, 390, 400),
    children: [
      { id: '1:2', type: 'VECTOR', name: 'Star Icon', fills: [{ type: 'SOLID', color: { r: 1, g: 0.8, b: 0, a: 1 } }], ...box(16, 16, 24, 24) },
      { id: '1:3', type: 'FRAME', name: 'Hero', cornerRadius: 12, clipsContent: false, ...box(16, 56, 358, 80),
        fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], gradientStops: [stop(0, 1, 0, 0), stop(1, 0, 0, 1)] }] },
      { id: '1:4', type: 'FRAME', name: 'Glow', ...box(16, 150, 100, 100),
        fills: [{ type: 'GRADIENT_RADIAL', gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], gradientStops: [stop(0, 1, 1, 1), stop(1, 0, 0, 0)] }] },
      { id: '1:5', type: 'FRAME', name: 'Clipped Card', cornerRadius: 8, clipsContent: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], ...box(130, 150, 100, 100) },
      { id: '1:6', type: 'FRAME', name: 'Conic', fills: [{ type: 'GRADIENT_ANGULAR', gradientStops: [stop(0, 1, 0, 0), stop(1, 0, 1, 0)] }],
        effects: [{ type: 'INNER_SHADOW', radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 1 } }], ...box(250, 150, 100, 100) },
      { id: '1:7', type: 'TEXT', name: 'Promo Text', characters: 'Gói 5G giá tốt', ...box(16, 270, 358, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, textAutoResize: 'HEIGHT' },
        characterStyleOverrides: [0, 0, 0, 0, 1, 1], styleOverrideTable: { 1: { fontWeight: 700 } } },
      { id: '1:9', type: 'FRAME', name: 'Hot Tag', rectangleCornerRadii: [4, 4, 0, 4], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], ...box(16, 330, 40, 20) },
      { id: '1:10', type: 'FRAME', name: 'Sheet', rectangleCornerRadii: [16, 8, 0, 0], clipsContent: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], ...box(70, 330, 100, 60) },
      { id: '1:8', type: 'TEXT', name: 'Brand', characters: 'Viettel', ...box(16, 300, 100, 20), style: { fontFamily: 'Viettel Sans', fontSize: 14, fontWeight: 400 } }
    ]
  }
}

const compiled = compileUIKit(screen, 'PromoView', { deploymentTarget: 13 })
const code = compiled.files.find(file => file.path === 'UIKit-Code/PromoView/PromoView.swift').content
const swiftUI = compiled.swiftUIFiles.find(file => file.path.endsWith('/PromoView.swift')).content
const node = outlet => compiled.previewRoot.children.find(child => child.outlet === outlet)

// K4: vector → ảnh export từ Figma (không vẽ lại khối màu); gradient → layer native.
assert.ok(isRasterCandidate(screen.root.children[0]))
assert.equal(node('starIcon').kind, 'image')
assert.ok(node('starIcon').meta.rasterized)
assert.match(code, /starIcon\.image = UIImage\(named: "starIcon"\)/)
assert.match(code, /let heroGradient = GradientLayerView\(\)/)
assert.match(code, /heroGradient\.gradient\.startPoint = CGPoint\(x: 0, y: 0\.5\)/)
assert.match(code, /final class GradientLayerView: UIView/)
assert.match(swiftUI, /LinearGradient\(/)
assert.match(swiftUI, /RadialGradient\(/)

// K6: bo góc không clip nếu Figma không bật clipsContent (phần tràn góc vẫn hiện); có bật thì clip.
assert.doesNotMatch(code, /hero\.layer\.masksToBounds = true/)
assert.match(code, /clippedCard\.layer\.masksToBounds = true/)

// K5: text nhiều weight → NSAttributedString (UIKit) và Text + Text (SwiftUI); SF Pro = system font.
assert.match(code, /NSMutableAttributedString\(string: "Gói 5G giá tốt"\)/)
assert.match(code, /UIFont\.systemFont\(ofSize: 14, weight: \.bold\)/)
assert.match(swiftUI, /\+ Text\("5G"\)\.fontWeight\(\.bold\)/)
assert.doesNotMatch(code + swiftUI, /starIconBackground/, 'vector đã raster không được vẽ thêm nền')
assert.doesNotMatch(swiftUI, /\.custom\("SF Pro"/)

// K5b: preview biết từng đoạn (kèm chuỗi gốc) để in đậm đúng chỗ, và tự bỏ qua khi text bị override.
assert.deepEqual(node('promoText').textRuns.map(run => [run.text, run.fontWeight]), [['Gói ', 400], ['5G', 700], [' giá tốt', 400]])

// K8: góc bo khác nhau. Cùng bán kính → maskedCorners; khác bán kính → TODO bên UIKit. SwiftUI luôn đúng nhờ shape riêng.
assert.match(code, /hotTag\.layer\.cornerRadius = 4\n\s+hotTag\.layer\.maskedCorners = \[\.layerMinXMinYCorner, \.layerMaxXMinYCorner, \.layerMinXMaxYCorner\]/)
assert.doesNotMatch(code, /TODO: \[hotTag\]/)
assert.match(code, /\/\/ TODO: \[sheet\] bo góc khác bán kính \(16\/8\/0\/0\)/)
assert.match(swiftUI, /\.background\(\n\s+CornerRadiiShape\(radii: \[4, 4, 0, 4\]\)\n\s+\.fill\(/)
assert.match(swiftUI, /\.clipShape\(CornerRadiiShape\(radii: \[16, 8, 0, 0\]\)\)/)
assert.equal(swiftUI.match(/private struct CornerRadiiShape: Shape/g).length, 1)
assert.ok(!compiled.swiftUIFiles.some(file => !file.content.includes('CornerRadiiShape(') && file.content.includes('struct CornerRadiiShape')))
assert.deepEqual(node('hotTag').style.cornerRadii, [4, 4, 0, 4])
for (const source of [code, swiftUI]) {
  source.split('\n').forEach((line, index, lines) => {
    assert.ok(line.length <= 120 || /swiftlint:disable:next line_length/.test(lines[index - 1]), `line too long: ${line}`)
  })
}

// K3: chỗ xấp xỉ/chưa hỗ trợ có "// TODO:" ngay tại code + TODO.md; SwiftLint không bắt rule `todo`.
for (const source of [code, swiftUI]) {
  assert.match(source, /\/\/ TODO: \[glow\] radial gradient/)
  assert.match(source, /\/\/ TODO: \[conic\] gradient angular/)
  assert.match(source, /\/\/ TODO: \[conic\] effect inner shadow/)
  assert.match(source, /\/\/ TODO: \[brand\] font "Viettel Sans"/)
  assert.doesNotMatch(source, /TODO: \[hero\]/, 'gradient đủ handle thì không cần TODO')
  for (const line of source.split('\n')) assert.ok(line.length <= 120 || !line.includes('TODO'), `TODO comment too long: ${line}`)
}
const todo = compiled.files.find(file => file.path === 'TODO.md')
assert.ok(todo, 'TODO.md must ship with the export')
assert.match(todo.content, /- \[ \] `conic` \(Conic\): gradient angular/)
assert.match(LINT_CONFIG_FILES.find(file => file.path === '.swiftlint.yml').content, /disabled_rules:\n {2}- todo/)

// Màn không có gì cần sửa tay thì không sinh TODO.md rỗng.
const plain = compileUIKit({ root: { id: '9:1', type: 'FRAME', name: 'Plain', ...box(0, 0, 100, 100), children: [] } }, 'PlainView', { deploymentTarget: 13 })
assert.ok(!plain.files.some(file => file.path === 'TODO.md'))

console.log('✓ Figma fidelity (rasterized vectors, native gradients, clip rules, mixed-weight text, TODO notes) passed')
