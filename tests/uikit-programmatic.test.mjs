import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen, layoutScreen } from './fixtures.mjs'

const compileFor = (data, name) => compileUIKit(data, name, { deploymentTarget: 13 })
const filesFor = (data, name) => Object.fromEntries(compileFor(data, name).files.map(file => [file.path, file.content]))

const layout = filesFor(layoutScreen, 'ScreenView')
const layoutCompiled = compileFor(layoutScreen, 'ScreenView')

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

// Dark Mode (T02): màu sắc phải đi qua Colors.xcassets (UIColor(named:)), không literal UIColor(red:...).
assert.doesNotMatch(xib, /UIColor\(red:/, 'generated Swift should reference named colors, not literal UIColor(red:)')
assert.doesNotMatch(code, /UIColor\(red:/, 'programmatic Swift should reference named colors, not literal UIColor(red:)')
assert.ok(layoutCompiled.colors.length > 0, 'compile should collect at least one color into the registry')
assert.ok(layoutCompiled.colors.every(entry => entry.name && entry.rgba), 'each color entry needs a name and an rgba value')
// Cùng giá trị RGBA ở nhiều node phải dùng lại đúng 1 tên (dedupe theo giá trị).
const names = layoutCompiled.colors.map(entry => entry.name)
assert.equal(new Set(names).size, names.length, 'color asset names must be unique')

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
