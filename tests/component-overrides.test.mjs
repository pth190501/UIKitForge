import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { banGoiNgayScreen } from './fixtures.mjs'

// "Bán gói ngày": 4 instance cùng component Plan card, mỗi cái một gói cước khác nhau; 2 cái cuối ẩn nhãn "Hot".
const compiled = compileUIKit(banGoiNgayScreen, 'BanGoiNgayView', { deploymentTarget: 13 })
const expected = [
  ['1.2 GB', '3 giờ', '10.000đ', false],
  ['3 GB', '6 giờ', '15.000đ', false],
  ['1.2 GB', '1 ngày', '10.000đ', true],
  ['30 GB', '30 ngày', '90.000đ', true]
]

const planCard = compiled.componentIRs.find(item => item.className === 'PlanCardQuickDataView')
assert.deepEqual(planCard.ir.slots.map(slot => `${slot.kind}:${slot.param}`), ['text:view3GBText', 'text:moiNgayText', 'text:view10000dText', 'hidden:scarcityHidden'])

// IR: mỗi instance mang đúng nội dung của nó.
const instances = []
const walk = node => { if (node.className === 'PlanCardQuickDataView') instances.push(node); for (const child of node.children || []) walk(child) }
walk(compiled.previewRoot)
assert.deepEqual(instances.map(node => node.overrides.map(item => item.value)), expected)

// UIKit: component có Content + configure(with:); màn chính (cả XIB lẫn Code) gọi cho từng instance.
for (const path of ['Components/PlanCardQuickDataView/PlanCardQuickDataView.swift', 'UIKit-Code/Components/PlanCardQuickDataView/PlanCardQuickDataView.swift']) {
  const swift = compiled.files.find(file => file.path === path).content
  assert.match(swift, /struct Content \{\n        let view3GBText: String\n/)
  assert.match(swift, /func configure\(with content: Content\) \{\n        view3GB\.text = content\.view3GBText/)
  assert.match(swift, /scarcity\.isHidden = content\.scarcityHidden/)
}
for (const path of ['BanGoiNgayView/BanGoiNgayView.swift', 'UIKit-Code/BanGoiNgayView/BanGoiNgayView.swift']) {
  const swift = compiled.files.find(file => file.path === path).content
  assert.equal((swift.match(/\.configure\(with: \.init\(/g) || []).length, 4, `${path}: one configure per plan card`)
  assert.match(swift, /view3GBText: "30 GB",\n\s+moiNgayText: "30 ngày",\n\s+view10000dText: "90\.000đ",\n\s+scarcityHidden: true/)
}

// SwiftUI: var có default = instance gốc; màn chính truyền giá trị riêng; phần ẩn bọc `if !scarcityHidden`.
const swiftUIComponent = compiled.swiftUIFiles.find(file => file.path.endsWith('PlanCardQuickDataView.swift')).content
assert.match(swiftUIComponent, /var view3GBText = "1\.2 GB"/)
assert.match(swiftUIComponent, /Text\(view3GBText\)/)
assert.match(swiftUIComponent, /if !scarcityHidden \{/)
const swiftUIMain = compiled.swiftUIFiles.find(file => file.path.endsWith('BanGoiNgay/BanGoiNgayView.swift')).content
assert.match(swiftUIMain, /PlanCardQuickDataView\(\n\s+view3GBText: "3 GB",/)

// Preview web: từng card hiện đúng nội dung của nó, không lặp card đầu tiên.
const shown = instances.map(node => {
  const texts = []
  const visit = (item, hiddenAncestor) => {
    const hidden = hiddenAncestor || item.hidden
    if (item.kind === 'label' && !hidden) texts.push(item.text)
    for (const child of item.children || []) visit(child, hidden)
  }
  for (const child of node.previewChildren || []) visit(child, false)
  return texts
})
assert.deepEqual(shown, [
  ['1.2 GB', '3 giờ', '10.000đ', 'Hot'],
  ['3 GB', '6 giờ', '15.000đ', 'Hot'],
  ['1.2 GB', '1 ngày', '10.000đ'],
  ['30 GB', '30 ngày', '90.000đ']
])

// Component không có khác biệt giữa instance → không sinh Content/configure thừa.
assert.doesNotMatch(compiled.files.find(file => file.path.endsWith('Components/WalletView/WalletView.swift')).content, /func configure/)

console.log('✓ component instance overrides (text + visibility) for UIKit, SwiftUI and preview passed')
