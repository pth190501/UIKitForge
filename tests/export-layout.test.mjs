import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { rerootSharedMVVMFile } from '../src/export-layout.js'
import { layoutScreen } from './fixtures.mjs'

const compiled = compileUIKit(layoutScreen, 'ScreenView', { deploymentTarget: 13 })

function visiblePathsFor(outputTarget) {
  return compiled.files
    .filter(file => file.target === outputTarget || file.target === 'uikit')
    .map(file => rerootSharedMVVMFile(file, outputTarget).path)
}

// UIKit-Code export phải tự chứa: view + ViewController/ViewModel/Router cùng gộp dưới đúng 1 folder
// gốc UIKit-Code/{rootClass}/ — trước fix, Router/VM/VC rớt ra {rootClass}/ trần, tách khỏi UIKit-Code/.
const codePaths = visiblePathsFor('uikit-code')
assert.ok(codePaths.length > 0, 'uikit-code export should not be empty')
for (const path of codePaths) assert.ok(path.startsWith('UIKit-Code/'), `${path} should live under UIKit-Code/`)
assert.ok(codePaths.includes('UIKit-Code/ScreenView/ScreenView.swift'))
assert.ok(codePaths.includes('UIKit-Code/ScreenView/ScreenViewController.swift'))
assert.ok(codePaths.includes('UIKit-Code/ScreenView/ScreenViewModel.swift'))
assert.ok(codePaths.includes('UIKit-Code/ScreenView/ScreenRouter.swift'))

// UIKit-XIB export giữ nguyên hành vi cũ: mọi file gộp dưới {rootClass}/, không có tiền tố UIKit-Code/.
const xibPaths = visiblePathsFor('uikit-xib')
for (const path of xibPaths) assert.ok(!path.startsWith('UIKit-Code/'), `${path} should not live under UIKit-Code/`)
assert.ok(xibPaths.includes('ScreenView/ScreenView.xib'))
assert.ok(xibPaths.includes('ScreenView/ScreenViewController.swift'))
assert.ok(xibPaths.includes('ScreenView/ScreenViewModel.swift'))
assert.ok(xibPaths.includes('ScreenView/ScreenRouter.swift'))

// File không thuộc target 'uikit' dùng chung (component target 'uikit-xib'/'uikit-code') không bị đổi path.
assert.equal(
  rerootSharedMVVMFile({ target: 'uikit-code', path: 'UIKit-Code/Components/X/X.swift' }, 'uikit-code').path,
  'UIKit-Code/Components/X/X.swift'
)
assert.equal(
  rerootSharedMVVMFile({ target: 'uikit', path: 'ScreenView/ScreenRouter.swift' }, 'uikit-xib').path,
  'ScreenView/ScreenRouter.swift'
)

console.log('✓ Export folder layout (UIKit-Code self-contained under UIKit-Code/) passed')
