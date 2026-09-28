import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { componentPropertiesScreen } from './fixtures.mjs'

// P9: tham số component đặt theo component property Figma; variant của cùng set có tên class theo giá trị variant.
const compiled = compileUIKit(componentPropertiesScreen, 'OffersView', { deploymentTarget: 13 })
assert.deepEqual(compiled.components.map(item => item.className), ['TagView', 'ButtonPrimaryView', 'ButtonSecondaryView'])

// UIKit: TEXT "Label" → label, BOOLEAN "Show icon" → showIcon (true = hiện, nên isHidden = !showIcon).
for (const path of ['Components/TagView/TagView.swift', 'UIKit-Code/Components/TagView/TagView.swift']) {
  const swift = compiled.files.find(file => file.path === path).content
  assert.match(swift, /struct Content \{\n\s+let showIcon: Bool\n\s+let label: String\n\s+\}/, path)
  assert.match(swift, /icon\.isHidden = !content\.showIcon\n\s+hot\.text = content\.label/, path)
}
const mainCode = compiled.files.find(file => file.path === 'UIKit-Code/OffersView/OffersView.swift').content
assert.match(mainCode, /\.init\(\n\s+showIcon: false,\n\s+label: "Mới"\n\s+\)/)

// SwiftUI: mặc định = instance gốc (hiện icon), điều kiện `if showIcon`, dữ liệu 3 tag trong mảng Item.
const tag = compiled.swiftUIFiles.find(file => file.path.endsWith('/TagView.swift')).content
assert.match(tag, /var showIcon = true\n\s+var label = "Hot"/)
assert.match(tag, /Group \{\n\s+if showIcon \{/)
assert.doesNotMatch(tag, /if !showIcon/)
const screen = compiled.swiftUIFiles.find(file => file.path === 'SwiftUI/Offers/OffersView.swift').content
assert.match(screen, /id: 1,\n\s+showIcon: false,\n\s+label: "Mới"/)
assert.match(screen, /ButtonPrimaryView\(\)[\s\S]*ButtonSecondaryView\(\)/)

// Variant nút vẫn là nút (UIControl) — tên set "Button".
assert.match(compiled.files.find(file => file.path === 'UIKit-Code/Components/ButtonPrimaryView/ButtonPrimaryView.swift').content, /final class ButtonPrimaryView: UIControl/)

// Preview web: tag "Mới" ẩn icon (showIcon = false ⇒ hidden), 2 tag còn lại hiện.
const tagPreviews = compiled.previewRoot.children.filter(child => child.className === 'TagView')
const iconHidden = tagPreviews.map(node => Boolean(node.previewChildren.find(child => child.outlet === 'icon')?.hidden))
assert.deepEqual(iconHidden, [false, true, false])

// Layer tên "Tag" không được thành outlet `tag` (trùng UIView.tag → lỗi compile "conflicts with getter for 'tag'").
const offersXib = compiled.files.find(file => file.path === 'OffersView/OffersView.swift').content
assert.match(offersXib, /@IBOutlet private weak var tagView: TagView!/)
assert.doesNotMatch(offersXib, /var tag: /)

console.log('✓ component properties (Figma TEXT/BOOLEAN names, variant class names) passed')
