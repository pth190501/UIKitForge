import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen, layoutScreen } from './fixtures.mjs'

const filesFor = (data, name, deploymentTarget) =>
  Object.fromEntries(compileUIKit(data, name, { deploymentTarget }).swiftUIFiles.map(file => [file.name, file.content]))

const ios13 = filesFor(layoutScreen, 'ScreenView', 13)
const ios17 = filesFor(layoutScreen, 'ScreenView', 17)

// MVVM-R: View + ViewModel + Router
assert.deepEqual(Object.keys(ios13).sort(), ['ScreenRouter.swift', 'ScreenView.swift', 'ScreenViewModel.swift'])
assert.match(ios13['ScreenRouter.swift'], /UIHostingController\(rootView: ScreenView\(viewModel: viewModel\)\)/)
assert.doesNotMatch(ios13['ScreenViewModel.swift'], /import (SwiftUI|UIKit)/, 'ViewModel must stay UI-framework free')
assert.match(ios13['ScreenViewModel.swift'], /@Published private\(set\) var title = "Title"/)

// Gate API theo deployment target
assert.match(ios13['ScreenView.swift'], /@ObservedObject var viewModel: ScreenViewModel/)
assert.match(ios13['ScreenView.swift'], /\.edgesIgnoringSafeArea\(\.all\)/)
assert.match(ios13['ScreenView.swift'], /PreviewProvider/)
for (const api of ['foregroundStyle', 'ignoresSafeArea', '#Preview', '@Observable', 'LazyVStack', 'NavigationStack']) {
  assert.ok(!Object.values(ios13).some(content => content.includes(api)), `iOS 13 output must not use ${api}`)
}
assert.match(ios17['ScreenViewModel.swift'], /@Observable\nfinal class ScreenViewModel \{/)
assert.match(ios17['ScreenView.swift'], /let viewModel: ScreenViewModel/)
assert.match(ios17['ScreenView.swift'], /\.foregroundStyle\(/)
assert.match(ios17['ScreenView.swift'], /#Preview \{/)
assert.match(filesFor(layoutScreen, 'ScreenView', 14)['ScreenView.swift'], /\.ignoresSafeArea\(\)/)

// Layout: stack, space-between, fill, absolute overlay, section tách riêng
const view = ios13['ScreenView.swift']
assert.match(view, /private extension ScreenView \{/)
assert.match(view, /var rowSection: some View \{\n {8}HStack\(alignment: \.center, spacing: 8\) \{/)
assert.match(view, /VStack\(alignment: \.leading, spacing: 0\) \{\n {12}Color\.clear\n {16}\.frame\(height: 48\)\n {16}\.frame\(maxWidth: \.infinity\)\n {12}Spacer\(minLength: 0\)/)
assert.match(view, /\.overlay\(\n {12}ZStack\(alignment: \.topLeading\)/, 'absolute children render in an overlay')
assert.match(view, /alignment: \.topTrailing\)/, 'RIGHT-pinned badge aligns top trailing')
assert.match(view, /Text\(viewModel\.caption\)[\s\S]*?\.padding\(EdgeInsets\(top: 300, leading: 16, bottom: 0, trailing: 174\)\)/)

// Component: thứ tự size → style, escape chuỗi, border/shadow
const card = filesFor(cardScreen, 'HomeView', 15)
assert.match(card['HomeView.swift'], /PackageCardView\(\)\n {16}\.frame\(maxWidth: \.infinity\)/)
const component = card['PackageCardView.swift']
assert.match(component, /Text\("Fast \\"Data\\""\)/)
assert.match(component, /\.frame\(width: 40, height: 40\)\n {16}\.opacity\(0\.5\)/, 'size modifiers precede style modifiers')
assert.ok(component.indexOf('.frame(maxWidth: .infinity, alignment: .topLeading)') < component.indexOf('.background('), 'container frame precedes background')
assert.match(component, /\.stroke\(Color\("packageCardBorder"\), lineWidth: 1\)/)

// Cấu trúc hợp lệ: ngoặc cân bằng, không dòng quá 120 ký tự, kết thúc bằng một newline
for (const [name, content] of Object.entries({ ...ios13, ...ios17, ...card })) {
  const count = char => content.split(char).length - 1
  assert.equal(count('{'), count('}'), `${name}: unbalanced braces`)
  assert.equal(count('('), count(')'), `${name}: unbalanced parentheses`)
  assert.ok(content.split('\n').every(line => line.length <= 120), `${name}: line exceeds 120 characters`)
  assert.ok(content.endsWith('}\n') && !content.endsWith('\n\n'), `${name}: must end with a single newline`)
}

console.log('✓ SwiftUI MVVM-R generation passed')
