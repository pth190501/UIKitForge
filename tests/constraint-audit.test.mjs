import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { banGoiNgayScreen, cardScreen, feedSlotScreen, layoutScreen } from './fixtures.mjs'

// Auto Layout không cần "4 constraint/view" mà cần xác định được đủ x, y, width, height:
// - view tự do (không trong UIStackView): đủ 2 constraint mỗi trục, hoặc 1 nếu có intrinsic size;
// - arranged subview: stack lo vị trí (và trục phụ nếu alignment .fill); còn lại phải có size constraint,
//   là FILL theo trục chính, hoặc tự có kích thước (label, stack, component tự co theo stack bên trong).
const H = new Set(['leading', 'trailing', 'centerX', 'width'])
const V = new Set(['top', 'bottom', 'centerY', 'height'])
const SIZE = { h: 'width', v: 'height' }

function auditLayout(compiled) {
  const componentRoots = new Map((compiled.componentIRs || []).map(({ className, ir }) => [className, ir]))
  const selfSizing = node => node.kind === 'label' || Boolean(node.stack) || (node.kind === 'component' && Boolean(componentRoots.get(node.className)?.stack))
  const issues = []
  const walk = (node, parent, scope) => {
    if (parent) {
      const constraints = node.constraints || []
      const has = type => constraints.some(item => item.type === type)
      if (node.arranged && parent.stack) {
        const main = parent.stack.axis === 'horizontal' ? 'h' : 'v'
        const cross = main === 'h' ? 'v' : 'h'
        const sizing = node.sizing || {}
        if (sizing[main] !== 'FILL' && !has(SIZE[main]) && !selfSizing(node)) issues.push(`${scope}: ${node.outlet} has no ${SIZE[main]} along the stack axis`)
        if (parent.stack.alignment !== 'fill' && !has(SIZE[cross]) && !selfSizing(node)) issues.push(`${scope}: ${node.outlet} has no ${SIZE[cross]} across the stack (alignment ${parent.stack.alignment})`)
      } else {
        const h = constraints.filter(item => H.has(item.type)).length
        const v = constraints.filter(item => V.has(item.type)).length
        const need = selfSizing(node) ? 1 : 2
        if (h < need || v < need) issues.push(`${scope}: ${node.outlet} is pinned with only h=${h} v=${v} constraints`)
      }
    }
    for (const child of node.children || []) walk(child, node, scope)
  }
  walk(compiled.previewRoot, null, 'main')
  for (const { className, ir } of compiled.componentIRs || []) walk(ir, null, className)
  return issues
}

for (const [name, data] of Object.entries({ layoutScreen, cardScreen, feedSlotScreen, banGoiNgayScreen })) {
  const issues = auditLayout(compileUIKit(data, 'GeneratedView', { deploymentTarget: 13 }))
  assert.deepEqual(issues, [], `${name}: ambiguous Auto Layout\n${issues.join('\n')}`)
}

// Audit phải thực sự bắt được lỗi: view thường trong stack, không size, không intrinsic → báo.
const broken = compileUIKit(layoutScreen, 'GeneratedView', { deploymentTarget: 13 })
const icon = broken.previewRoot.children[0].children.find(child => child.outlet === 'icon')
icon.constraints = icon.constraints.filter(item => item.type !== 'width')
assert.ok(auditLayout(broken).some(issue => issue.includes('icon has no width')), 'audit must flag a missing size constraint')

// SPACE_BETWEEN với đúng 1 con FILL (header "Feed/ News") → .fill, không phải .equalSpacing (không kéo giãn).
const feed = compileUIKit(feedSlotScreen, 'GeneratedView', { deploymentTarget: 13 })
const header = feed.previewRoot.children.find(child => child.outlet === 'header')
assert.equal(header.stack.distribution, 'fill')
assert.doesNotMatch(feed.files.find(file => file.path === 'UIKit-Code/GeneratedView/GeneratedView.swift').content, /headerStack\.distribution = \.equalSpacing/)

console.log('✓ constraint audit (every view resolves x/y/width/height) + single-FILL space-between passed')
