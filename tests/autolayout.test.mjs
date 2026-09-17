import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler-core.js'
import { layoutScreen as data } from './fixtures.mjs'

const compiled = compileUIKit(data, 'ScreenView', { deploymentTarget: '15.4' })
const root = compiled.previewRoot
const [row, actions, a, b, caption, pill] = root.children
const types = node => node.constraints.map(item => item.type + (item.atLeast ? '>=' : '') + (item.target ? '@stack' : '') + (item.targetFigmaId ? `@${item.targetFigmaId}` : ''))

// Deployment target
assert.equal(compiled.deploymentTarget, 15)
assert.equal(compileUIKit(data, 'X', { deploymentTarget: '9' }).deploymentTarget, 13, 'minimum supported target is iOS 13')
assert.equal(compileUIKit(data, 'X').deploymentTarget, 13)

// ID ổn định + không trùng
assert.notEqual(a.id, b.id, 'ids sharing a suffix must not collide')
assert.equal(compileUIKit(data, 'ScreenView').previewRoot.children[2].id, a.id, 'ids must be stable across compiles')

// Stack ngang
assert.deepEqual({ ...row.stack, pins: undefined, id: undefined, frame: undefined }, { axis: 'horizontal', spacing: 8, alignment: 'center', distribution: 'fill', pins: undefined, id: undefined, frame: undefined })
assert.deepEqual(row.stack.pins.map(pin => pin.type), ['top', 'bottom', 'leading', 'trailing'], 'fill child pins stack at both ends')
assert.deepEqual(row.stack.frame, { x: 16, y: 12, width: 358, height: 24 })
const [icon, title, value, badge] = row.children
assert.deepEqual(types(icon), ['width', 'height'])
assert.deepEqual(types(title), [], 'labels never get fixed size constraints')
assert.equal(title.priorities.huggingH, 249, 'main-axis FILL lowers hugging priority')
assert.equal(value.priorities.compressionH, 749, 'second label in a horizontal stack yields compression')
assert.equal(badge.arranged, false)
assert.deepEqual(types(badge), ['trailing', 'width', 'top', 'height'])
assert.deepEqual(types(row), ['leading', 'trailing', 'top', 'bottom>='], 'HUG height container gets no height constant')

// Stack dọc space-between
assert.equal(actions.stack.distribution, 'equalSpacing')
assert.equal(actions.stack.spacing, 0)
assert.equal(actions.stack.alignment, 'leading')
assert.deepEqual(types(actions.children[0]), ['width@stack', 'height'], 'cross-axis FILL equals stack width when alignment is not fill')

// Label pin LEFT → leading + trailing, không width
assert.deepEqual(types(caption), ['leading', 'trailing', 'top', 'bottom>='])

// Hug container center + stack center
assert.deepEqual(types(pill), ['centerX', 'leading>=', 'top', 'height'])
assert.deepEqual(pill.stack.pins.map(pin => pin.type), ['top', 'bottom', 'leading', 'trailing'], 'HUG container is sized by its stack')

// XIB: deployment, stack, relation, và mọi id/tham chiếu hợp lệ
const xib = compiled.files.find(file => file.name === 'ScreenView.xib').content
assert.match(xib, /<deployment version="3840" identifier="iOS"\/>/)
assert.match(xib, /<stackView [^>]*distribution="equalSpacing"[^>]*alignment="leading"/)
assert.match(xib, /relation="greaterThanOrEqual"/)
assert.match(xib, /<label [^>]*horizontalHuggingPriority="249"[^>]*text="Title"/)
assert.ok(!xib.includes(`firstItem="${caption.id}" firstAttribute="width"`), 'Caption label must not have a fixed width')

const ids = [...xib.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
assert.equal(new Set(ids).size, ids.length, `XIB ids must be unique: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`)
const refs = [...xib.matchAll(/(?:firstItem|secondItem|destination)="([^"]+)"/g)].map(match => match[1])
for (const ref of refs) assert.ok(ids.includes(ref), `dangling XIB reference ${ref}`)

const warnings = compiled.warnings.filter(item => item.includes('two-axis'))
assert.deepEqual(warnings, [], 'arranged subviews must not trigger missing-constraint warnings')

console.log('✓ auto layout IR + stable XIB ids passed')
