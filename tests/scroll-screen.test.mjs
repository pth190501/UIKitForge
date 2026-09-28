import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { ARCHITECTURES } from '../src/uikit-router.js'
import { layoutScreen, longScreen } from './fixtures.mjs'

// P7: màn cao hơn thiết bị → UIScrollView (VC) / ScrollView (SwiftUI); màn vừa màn hình giữ nguyên.
for (const architecture of ARCHITECTURES) {
  const compiled = compileUIKit(longScreen, 'GeneratedView', { deploymentTarget: 13, architecture })
  assert.deepEqual(compiled.scroll, { height: 1400, fixedHeight: true })
  const vc = compiled.files.find(file => file.path === 'GeneratedView/GeneratedViewController.swift').content
  assert.match(vc, /let scrollView = UIScrollView\(\)/, architecture)
  assert.match(vc, /contentView\.widthAnchor\.constraint\(equalTo: scrollView\.frameLayoutGuide\.widthAnchor\),\n\s+contentView\.heightAnchor\.constraint\(equalToConstant: 1400\)/, architecture)
  assert.match(vc, /view = scrollView/, architecture)
  const screen = compiled.swiftUIFiles.find(file => file.path === 'SwiftUI/Generated/GeneratedView.swift').content
  assert.match(screen, /var body: some View \{\n\s+ScrollView \{\n/, architecture)
  assert.match(screen, /\.frame\(height: 1400\)\n\s+\}\n\s+\.edgesIgnoringSafeArea\(\.all\)/, architecture)
}

const normal = compileUIKit(layoutScreen, 'GeneratedView', { deploymentTarget: 13 })
assert.equal(normal.scroll, null)
assert.match(normal.files.find(file => file.path === 'GeneratedView/GeneratedViewController.swift').content, /view = contentView/)
assert.doesNotMatch(normal.swiftUIFiles.map(file => file.content).join('\n'), /ScrollView/)

// Designer bật scroll dọc trên khung hug nội dung → cuộn nhưng không ghim chiều cao (nội dung tự quyết định).
const hugging = compileUIKit({ root: { ...layoutScreen.root, overflowDirection: 'VERTICAL_SCROLLING', layoutMode: 'VERTICAL', layoutSizingVertical: 'HUG', primaryAxisSizingMode: 'AUTO' } }, 'GeneratedView', { deploymentTarget: 13 })
assert.equal(hugging.scroll?.fixedHeight, false)
const hugVC = hugging.files.find(file => file.path === 'GeneratedView/GeneratedViewController.swift').content
assert.match(hugVC, /let scrollView = UIScrollView\(\)/)
assert.doesNotMatch(hugVC, /heightAnchor/)

console.log('✓ scroll screens (UIScrollView / ScrollView for content taller than the device) passed')
