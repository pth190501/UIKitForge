import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen } from './fixtures.mjs'

// UILabel: Dynamic Type qua UIFontMetrics thay vì UIFont.systemFont cố định.
const cardCompiled = compileUIKit(cardScreen, 'HomeView')
const cardXib = Object.fromEntries(cardCompiled.files.map(file => [file.path, file.content]))
const titleSwift = cardXib['Components/PackageCardView/PackageCardView.swift']
assert.match(titleSwift, /UIFontMetrics\(forTextStyle: \.callout\)\.scaledFont\(for: UIFont\.systemFont\(ofSize: 16, weight: \.semibold\)\)/)
assert.match(titleSwift, /\.adjustsFontForContentSizeCategory = true/)

// UIImageView: accessibilityLabel lấy từ tên layer Figma, đã humanize.
assert.match(titleSwift, /hero\.isAccessibilityElement = true/)
assert.match(titleSwift, /hero\.accessibilityLabel = "Hero"/)

// Package Card instance 358x64pt -> trên ngưỡng 44pt, không cảnh báo tap target.
assert.ok(!cardCompiled.warnings.some(w => w.includes('minimum tap target')))

// Component instance nhỏ hơn 44x44pt -> phải có cảnh báo minimum tap target.
const smallButtonScreen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Screen', absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
    children: [{
      id: '1:2', type: 'INSTANCE', componentId: 'icon-button', name: 'Icon Button',
      constraints: { horizontal: 'LEFT', vertical: 'TOP' },
      absoluteBoundingBox: { x: 16, y: 16, width: 28, height: 28 },
      children: []
    }]
  }
}
const smallButtonCompiled = compileUIKit(smallButtonScreen, 'ScreenView')
assert.ok(smallButtonCompiled.warnings.some(w => w.includes('Icon Button') && w.includes('minimum tap target')), 'expected a 44pt tap-target warning for the small component instance')

console.log('✓ accessibility defaults (Dynamic Type, VoiceOver labels, tap target warning) passed')
