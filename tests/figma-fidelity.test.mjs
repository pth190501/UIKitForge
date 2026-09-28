import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { isRasterCandidate } from '../src/figma.js'
import { LINT_CONFIG_FILES } from '../src/lint-config.js'
import { banGoiNgayScreen, fidelityScreen as screen, layoutScreen } from './fixtures.mjs'

// Node "khó" kiểu màn 34715:42593 (fidelityScreen trong fixtures.mjs): vector, gradient, text nhiều kiểu, bo góc, effect lạ.
const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })

const compiled = compileUIKit(screen, 'PromoView', { deploymentTarget: 13 })
const code = compiled.files.find(file => file.path === 'UIKit-Code/PromoView/PromoView.swift').content
const swiftUI = compiled.swiftUIFiles.find(file => file.path.endsWith('/PromoView.swift')).content
const node = outlet => compiled.previewRoot.children.find(child => child.outlet === outlet)

// K4: vector → ảnh export từ Figma (không vẽ lại khối màu); gradient → layer native.
assert.ok(isRasterCandidate(screen.root.children[0]))
assert.equal(node('starIcon').kind, 'image')
assert.ok(node('starIcon').meta.rasterized)
assert.match(code, /starIcon\.image = UIImage\(named: "starIcon"\)/)
assert.match(code, /do \{\n\s+let gradientView = GradientLayerView\(\)/)
assert.match(code, /gradientView\.gradient\.startPoint = CGPoint\(x: 0, y: 0\.5\)\n[\s\S]*?gradientView\.install\(in: hero\)/)
assert.match(code, /override static var layerClass/)
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
// P5: bán kính khác nhau → nền vẽ bằng CornerRadiiShapeView (UIKit), clip host vì Figma bật clipsContent.
assert.doesNotMatch(code, /TODO: \[sheet\]/)
assert.match(code, /let shapeView = CornerRadiiShapeView\(radii: \[16, 8, 0, 0\]\)\n\s+shapeView\.fillColor = UIColor\(named: "\w+"\)\n\s+shapeView\.clipsHost = true\n\s+shapeView\.install\(in: sheet\)/)
assert.doesNotMatch(code, /sheet\.(backgroundColor|layer\.cornerRadius|layer\.maskedCorners)/)
assert.match(code, /private final class CornerRadiiShapeView: UIView/)
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
  assert.doesNotMatch(source, /TODO: \[conic\] gradient angular/, 'angular gradient giờ sinh native')
  assert.match(source, /\/\/ TODO: \[conic\] effect inner shadow/)
  assert.match(source, /\/\/ TODO: \[brand\] font "Viettel Sans"/)
  assert.doesNotMatch(source, /TODO: \[hero\]/, 'gradient đủ handle thì không cần TODO')
  for (const line of source.split('\n')) assert.ok(line.length <= 120 || !line.includes('TODO'), `TODO comment too long: ${line}`)
}
const todo = compiled.files.find(file => file.path === 'TODO.md')
assert.ok(todo, 'TODO.md must ship with the export')
assert.match(todo.content, /- \[ \] `conic` \(Conic\): effect inner shadow/)
// P3: angular gradient native — .conic (UIKit) và AngularGradient (SwiftUI).
assert.match(code, /gradientView\.gradient\.type = \.conic/)
assert.match(swiftUI, /AngularGradient\(\n[\s\S]*?startAngle: \.degrees\(/)
assert.match(LINT_CONFIG_FILES.find(file => file.path === '.swiftlint.yml').content, /disabled_rules:\n {2}- todo/)

// Tên layer thật ("Bán gói ngày") có ký tự điều khiển U+001D — XML 1.0 cấm, ibtool từ chối cả file XIB.
const xibs = compileUIKit(banGoiNgayScreen, 'GeneratedView', { deploymentTarget: 13 }).files.filter(file => file.path.endsWith('.xib'))
assert.ok(xibs.length > 1)
// eslint-disable-next-line no-control-regex
for (const file of xibs) assert.doesNotMatch(file.content, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, `${file.path} has XML-invalid characters`)

// SwiftLint --strict trên màn lớn: tên biến ≤ 40 ký tự, và chỉ tắt length rule đúng chỗ vượt ngưỡng (số dòng đã đối
// chiếu với SwiftLint thật trên CI: configureList 240, applyGeneratedStyle 143, class 496, file 534).
const ban = compileUIKit(banGoiNgayScreen, 'GeneratedView', { deploymentTarget: 17 })
for (const file of [...ban.files, ...ban.swiftUIFiles].filter(item => item.language === 'swift')) {
  for (const [, name] of file.content.matchAll(/\b(?:let|var) (\w+)/g)) assert.ok(name.length <= 40, `${file.path}: ${name} exceeds identifier_name`)
}
const banCode = ban.files.find(file => file.path === 'UIKit-Code/GeneratedView/GeneratedView.swift').content
assert.ok(banCode.startsWith('// swiftlint:disable file_length\n'))
assert.match(banCode, /\nfinal class GeneratedView: UIView \{ \/\/ swiftlint:disable:this type_body_length\n/)
assert.match(banCode, /private func configureList\(\) \{ \/\/ swiftlint:disable:this function_body_length\n/)
assert.match(banCode, /private func applyGeneratedStyle\(\) \{ \/\/ swiftlint:disable:this function_body_length\n/)
assert.match(banCode, /private func commonInit\(\) \{\n/, 'hàm ngắn không được disable (superfluous_disable_command)')
// Bản XIB có doc comment (///) ngay trên applyGeneratedStyle — không được chen dòng nào vào giữa (orphaned_doc_comment).
const banXib = ban.files.find(file => file.path === 'GeneratedView/GeneratedView.swift').content
assert.match(banXib, /\/\/\/ [^\n]*\n\s+private func applyGeneratedStyle\(\) \{ \/\/ swiftlint:disable:this function_body_length/)
const small = compileUIKit(layoutScreen, 'GeneratedView', { deploymentTarget: 17 }).files.filter(file => file.language === 'swift')
for (const file of small) assert.doesNotMatch(file.content, /swiftlint:disable(:next)? (file_length|type_body_length|function_body_length)/, file.path)

// P3: image fill trên container có con → asset nền riêng (ảnh gốc theo imageRef), con giữ nguyên phía trên.
assert.deepEqual(node('banner').style.backgroundImage, { imageRef: 'img-banner', scaleMode: 'FILL' })
assert.match(code, /let backgroundView = BackgroundImageView\(\)\n\s+backgroundView\.image = UIImage\(named: "bannerBackground"\)\n\s+backgroundView\.contentMode = \.scaleAspectFill\n\s+backgroundView\.install\(in: banner\)/)
assert.match(code, /private final class BackgroundImageView: UIImageView/)
assert.match(swiftUI, /Image\(decorative: "bannerBackground"\)\n\s+\.resizable\(\)\n\s+\.scaledToFill\(\)\n\s+\)\n\s+\.clipped\(\)/)
assert.doesNotMatch(code + swiftUI, /TODO: \[banner\]/)
assert.ok(compiled.warnings.some(item => item.includes('"bannerBackground"')))
// Angular có handle: hướng bắt đầu lên trên (12 giờ) = -90° trong SwiftUI.
assert.match(swiftUI, /startAngle: \.degrees\(-90\),\n\s+endAngle: \.degrees\(270\)/)

// Màn không có gì cần sửa tay thì không sinh TODO.md rỗng.
const plain = compileUIKit({ root: { id: '9:1', type: 'FRAME', name: 'Plain', ...box(0, 0, 100, 100), children: [] } }, 'PlainView', { deploymentTarget: 13 })
assert.ok(!plain.files.some(file => file.path === 'TODO.md'))

console.log('✓ Figma fidelity (rasterized vectors, native gradients, clip rules, mixed-weight text, TODO notes) passed')
