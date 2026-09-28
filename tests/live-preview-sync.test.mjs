import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { applySwiftPreview } from '../src/preview.js'
import { cardScreen } from './fixtures.mjs'

const compiled = compileUIKit(cardScreen, 'HomeView', { deploymentTarget: 13 })
const { namedColors } = compiled
const swiftFor = (path) => compiled.files.find(file => file.path === path)
const RED = 'UIColor(red: 1, green: 0, blue: 0, alpha: 1)'

assert.ok(namedColors.homeBackground, 'namedColors should expose registry colors by asset name')

// UIColor(named:) trong code sinh ra phải dịch ngược được về rgba qua namedColors.
const xibMain = swiftFor('HomeView/HomeView.swift').content
assert.match(xibMain, /contentView\.backgroundColor = UIColor\(named: "homeBackground"\)/)
const withNamed = applySwiftPreview(compiled.previewRoot, xibMain.replace('UIColor(named: "homeBackground")', 'UIColor(named: "packageCardBackground")'), { namedColors })
assert.equal(withNamed.style.background, namedColors.packageCardBackground)

// Tên asset không có trong registry → giữ style gốc thay vì xoá màu.
const unknownNamed = applySwiftPreview(compiled.previewRoot, xibMain.replace('UIColor(named: "homeBackground")', 'UIColor(named: "doesNotExist")'), { namedColors })
assert.equal(unknownNamed.style.background, compiled.previewRoot.style.background)

// Literal UIColor(red:...) do user tự gõ vẫn hoạt động như cũ.
const withLiteral = applySwiftPreview(compiled.previewRoot, xibMain.replace('UIColor(named: "homeBackground")', RED), { namedColors })
assert.equal(withLiteral.style.background, 'rgba(255, 0, 0, 1)')

// Biến thể Code gán màu root thẳng trên self (không có tiền tố contentView.).
const codeMain = swiftFor('UIKit-Code/HomeView/HomeView.swift').content
assert.match(codeMain, /^\s+backgroundColor = UIColor\(named: "homeBackground"\)/m)
const codeRoot = applySwiftPreview(compiled.previewRoot, codeMain.replace('UIColor(named: "homeBackground")', RED), { namedColors })
assert.equal(codeRoot.style.background, 'rgba(255, 0, 0, 1)')

// Font bọc UIFontMetrics (Dynamic Type) vẫn phải live-update khi đổi size trong editor.
const componentFile = swiftFor('Components/PackageCardView/PackageCardView.swift')
assert.match(componentFile.content, /title\.font = UIFontMetrics\([^\n]*\n\s*\.scaledFont\(for: UIFont\.systemFont\(ofSize: 16, weight: \.semibold\)/)
componentFile.content = componentFile.content.replace('systemFont(ofSize: 16, weight: .semibold)', 'systemFont(ofSize: 24, weight: .bold)')
const title = compiled.componentPreviews.PackageCardView.children.find(child => child.outlet === 'title')
assert.equal(title.style.fontSize, 24)
assert.equal(title.style.fontWeight, 700)

// Outlet trùng hậu tố: sửa subtitle không được lan sang title.
const tree = {
  id: 'root', outlet: 'root', kind: 'view', style: {},
  children: [
    { id: 't', outlet: 'title', kind: 'view', style: { background: 'rgba(0, 0, 255, 1)' }, children: [] },
    { id: 's', outlet: 'subtitle', kind: 'view', style: {}, children: [] }
  ]
}
const suffixed = applySwiftPreview(tree, `        subtitle.backgroundColor = ${RED}\n`)
assert.equal(suffixed.children[0].style.background, 'rgba(0, 0, 255, 1)', 'title must not pick up subtitle.backgroundColor')
assert.equal(suffixed.children[1].style.background, 'rgba(255, 0, 0, 1)')
assert.equal(suffixed.style.background, undefined, 'root must not pick up a child assignment')

console.log('✓ live preview sync (named colors, UIFontMetrics fonts, UIKit-Code root, outlet boundaries) passed')
