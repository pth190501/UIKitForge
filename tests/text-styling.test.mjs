import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { textStylingScreen as screen } from './fixtures.mjs'

// P1: line height, letter spacing, textCase, gạch chân/ngang và màu theo từng đoạn chữ.

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
