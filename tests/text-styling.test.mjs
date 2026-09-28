import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'

// P1: line height, letter spacing, textCase, gạch chân/ngang và màu theo từng đoạn chữ.
const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
const solid = (r, g, b) => [{ type: 'SOLID', color: { r, g, b, a: 1 } }]
const screen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Promo', ...box(0, 0, 390, 400),
    children: [
      { id: '1:2', type: 'TEXT', name: 'Headline', characters: 'ưu đãi hôm nay', fills: solid(0, 0, 0), ...box(16, 16, 358, 44),
        style: { fontFamily: 'SF Pro', fontSize: 16, fontWeight: 600, lineHeightPx: 22, lineHeightUnit: 'PIXELS', letterSpacing: 0.5, textCase: 'UPPER', textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER' } },
      { id: '1:3', type: 'TEXT', name: 'Terms', characters: 'Xem điều khoản', fills: solid(0, 0, 0), ...box(16, 70, 358, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, lineHeightPx: 17, lineHeightUnit: 'INTRINSIC_%', textAutoResize: 'HEIGHT' },
        characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        styleOverrideTable: { 1: { fills: solid(0, 0.4, 1), textDecoration: 'UNDERLINE' } } },
      { id: '1:4', type: 'TEXT', name: 'Old Price', characters: '50.000đ', fills: solid(0.5, 0.5, 0.5), ...box(16, 100, 80, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, textDecoration: 'STRIKETHROUGH' } }
    ]
  }
}

const compiled = compileUIKit(screen, 'PromoView', { deploymentTarget: 13 })
const code = compiled.files.find(file => file.path === 'UIKit-Code/PromoView/PromoView.swift').content
const swiftUI = compiled.swiftUIFiles.find(file => file.path.endsWith('/PromoView.swift')).content
const viewModel = compiled.swiftUIFiles.find(file => file.path.endsWith('/PromoViewModel.swift')).content
const node = outlet => compiled.previewRoot.children.find(child => child.outlet === outlet)

// textCase UPPER áp vào chính chuỗi (Figma lưu chữ gốc, hiển thị in hoa).
assert.equal(node('headline').text, 'ƯU ĐÃI HÔM NAY')
assert.match(code, /headline\.text = "ƯU ĐÃI HÔM NAY"/)
assert.match(viewModel, /"ƯU ĐÃI HÔM NAY"/)

// UIKit: line height (nhiều dòng) qua paragraph style giữ alignment, kern cho letter spacing.
assert.match(code, /paragraph\.minimumLineHeight = 22\n\s+paragraph\.maximumLineHeight = 22\n\s+paragraph\.alignment = \.center/)
assert.match(code, /\.baselineOffset,\n\s+value: \(22 - \(headline\.font\?\.lineHeight \?\? 22\)\) \/ 4,/)
assert.match(code, /\.kern,\n\s+value: 0\.5,/)
// Line height "Auto" không sinh paragraph style.
assert.doesNotMatch(code, /minimumLineHeight = 17/)

// Đoạn đổi màu + gạch chân (chỉ đoạn "điều khoản"), label gạch ngang toàn bộ.
assert.match(code, /\.foregroundColor,\n\s+value: UIColor\(named: "\w+"\) \?\? \.label,\n\s+range: NSRange\(location: 4, length: 10\)/)
assert.match(code, /\.underlineStyle,\n\s+value: NSUnderlineStyle\.single\.rawValue,\n\s+range: NSRange\(location: 4, length: 10\)/)
assert.match(code, /\.strikethroughStyle,\n\s+value: NSUnderlineStyle\.single\.rawValue,\n\s+range: NSRange\(location: 0, length: attributed\.length\)/)
assert.doesNotMatch(code, /TODO: \[oldPrice\] text decoration/)

// SwiftUI: kerning/underline là modifier của Text, đặt trước modifier View; lineSpacing = 22 - 16 × 1.19.
assert.match(swiftUI, /\.font\(\.system\(size: 16, weight: \.semibold\)\)\n\s+\.kerning\(0\.5\)/)
assert.match(swiftUI, /\.lineSpacing\(2\.96\)/)
assert.match(swiftUI, /\+ Text\("điều khoản"\)\.foregroundColor\(Color\("\w+"\)\)\.underline\(\)/)
assert.match(swiftUI, /\.strikethrough\(\)/)

// Preview: runs mang màu/gạch để vẽ <span> đúng.
assert.deepEqual(node('terms').textRuns.map(run => [run.text, run.decoration]), [['Xem ', null], ['điều khoản', 'UNDERLINE']])
assert.equal(node('oldPrice').style.textDecoration, 'STRIKETHROUGH')

for (const source of [code, swiftUI]) {
  source.split('\n').forEach((line, index, lines) => {
    assert.ok(line.length <= 120 || /swiftlint:disable:next line_length/.test(lines[index - 1]), `line too long: ${line}`)
  })
}

console.log('✓ text styling (line height, letter spacing, text case, per-run color/decoration) passed')
