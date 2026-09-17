import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen, layoutScreen } from './fixtures.mjs'

const filesFor = (data, name) => {
  const compiled = compileUIKit(data, name, { deploymentTarget: 13 })
  return Object.fromEntries(compiled.files.map(file => [file.path, file.content]))
}

const layout = filesFor(layoutScreen, 'ScreenView')

// Router/VM/VC dùng chung cho cả XIB và Code, chỉ có 1 bộ mỗi output.
assert.match(layout['ScreenView/ScreenViewController.swift'], /private let contentView = ScreenView\(frame: \.zero\)/)
assert.match(layout['ScreenView/ScreenRouter.swift'], /let viewController = ScreenViewController\(viewModel: viewModel\)/)
assert.doesNotMatch(layout['ScreenView/ScreenViewModel.swift'], /import (UIKit|SwiftUI)/, 'ViewModel must stay UI-framework free')

// Biến thể Code: không XIB, không @IBOutlet/Bundle nib, có NSLayoutConstraint từ IR.
const code = layout['UIKit-Code/ScreenView/ScreenView.swift']
assert.ok(code, 'programmatic ScreenView.swift should be generated')
assert.doesNotMatch(code, /@IBOutlet|loadNibNamed/, 'programmatic view must not reference a XIB')
assert.match(code, /private let rowStack = UIStackView\(\)/)
assert.match(code, /rowStack\.addArrangedSubview\(icon\)/)
assert.match(code, /icon\.widthAnchor\.constraint\(equalToConstant: 24\)\.isActive = true/)
assert.match(code, /configureRow\(\)/, 'commonInit should delegate per-child setup to keep function_body_length low')
assert.doesNotMatch(code, /self\./, 'redundant self should not appear (SwiftFormat --self remove)')

// Biến thể XIB: giữ nguyên hành vi cũ (outlet + nib load), không đổi khi thêm biến thể Code.
const xib = layout['ScreenView/ScreenView.swift']
assert.match(xib, /@IBOutlet private weak var row: UIView!/)
assert.match(xib, /loadNibNamed/)

// Component cũng có cả hai biến thể, cùng class name, khác path.
const card = filesFor(cardScreen, 'HomeView')
assert.ok(card['Components/PackageCardView/PackageCardView.swift'])
assert.ok(card['UIKit-Code/Components/PackageCardView/PackageCardView.swift'])

// Config tĩnh luôn đi kèm export.
assert.ok(layout['.swiftlint.yml'].includes('min_length: 3'))
assert.ok(layout['.swiftformat'].includes('--self remove'))

// Cấu trúc hợp lệ: ngoặc cân bằng, kết thúc bằng một newline.
for (const [name, content] of Object.entries(layout)) {
  if (!name.endsWith('.swift')) continue
  const count = char => content.split(char).length - 1
  assert.equal(count('{'), count('}'), `${name}: unbalanced braces`)
  assert.equal(count('('), count(')'), `${name}: unbalanced parentheses`)
  assert.ok(content.endsWith('}\n'), `${name}: must end with a single newline`)
}

console.log('✓ UIKit programmatic + MVVM-R router generation passed')
