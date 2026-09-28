import assert from 'node:assert/strict'
import { createColorRegistry, planColorNames, styleColorNames } from '../src/color-registry.js'
import { compileUIKit } from '../src/compiler.js'
import { fidelityScreen } from './fixtures.mjs'

const registry = createColorRegistry()

// Cùng giá trị RGBA -> cùng tên, dù hint khác nhau (dedupe theo giá trị màu, không theo hint).
const first = registry.register('rgba(255, 255, 255, 1)', 'cardBackground')
const second = registry.register('rgba(255, 255, 255, 1)', 'heroBackground')
assert.equal(first, second)

// Giá trị khác nhau -> tên khác nhau, dù hint trùng nhau (tránh 2 màu khác nhau dùng chung 1 tên).
const third = registry.register('rgba(0, 0, 0, 1)', 'cardBackground')
assert.notEqual(first, third)
assert.equal(third, 'cardBackground2')

// Hint không hợp lệ (ký tự đặc biệt, số đứng đầu) vẫn ra tên Swift-safe.
const fourth = registry.register('rgba(10, 20, 30, 0.5)', '12 Weird-Hint!!')
assert.match(fourth, /^[a-zA-Z][A-Za-z0-9]*$/)

// entries() trả đúng số lượng màu duy nhất, không trùng tên.
const entries = registry.entries()
assert.equal(entries.length, 3)
assert.equal(new Set(entries.map(e => e.name)).size, 3)

// Sai lệch nhỏ do định dạng (thừa khoảng trắng, alpha thiếu số 0) vẫn coi là cùng 1 màu.
const fifth = registry.register('rgba(255,255,255,1)', 'anotherHint')
assert.equal(fifth, first)

console.log('✓ color registry dedupe + naming passed')

// P2: tên màu chốt sau khi biết mọi nơi dùng — style Figma > một nơi dùng > tên theo giá trị (+ vai trò chung).
const planned = planColorNames([
  { rgba: 'rgba(255, 255, 255, 1)', hints: ['glowGradient', 'clippedCardBackground'] },
  { rgba: 'rgba(51, 64, 74, 1)', hints: ['titleText', 'bodyRun'] },
  { rgba: 'rgba(0, 0, 0, 0.2)', hints: ['cardShadow'] },
  { rgba: 'rgba(48, 120, 255, 1)', hints: ['ctaBackground', 'linkText'] }
], new Map([['rgba(48, 120, 255, 1)', 'Primary/Blue 500']]))
assert.equal(planned.get('rgba(255, 255, 255, 1)'), 'white')
assert.equal(planned.get('rgba(51, 64, 74, 1)'), 'text33404A')
assert.equal(planned.get('rgba(0, 0, 0, 0.2)'), 'cardShadow')
assert.equal(planned.get('rgba(48, 120, 255, 1)'), 'primaryBlue500')

// Registry dùng tên đã chốt; vẫn ghi lại mọi vai trò của màu.
const fixed = createColorRegistry({ names: planned })
assert.equal(fixed.register('rgba(255,255,255,1)', 'somethingElse'), 'white')
assert.deepEqual(fixed.usage(), [{ rgba: 'rgba(255, 255, 255, 1)', hints: ['somethingElse'] }])

// Style Figma: node.styles.fill → styles[id].name.
const styled = styleColorNames({ id: '1', type: 'FRAME', styles: { fill: 'S:1' }, fills: [{ type: 'SOLID', color: { r: 48 / 255, g: 120 / 255, b: 1, a: 1 } }] }, { 'S:1': { name: 'Primary/Blue 500', styleType: 'FILL' } })
assert.equal(styled.get('rgba(48, 120, 255, 1)'), 'Primary/Blue 500')

// End-to-end: màu trắng dùng cho gradient + nền + chữ ở nhiều view → "white", không mang tên view đầu tiên.
const promo = compileUIKit(fidelityScreen, 'PromoView', { deploymentTarget: 13 })
assert.ok(promo.colors.some(color => color.name === 'white' && color.rgba === 'rgba(255, 255, 255, 1)'))
assert.ok(!promo.colors.some(color => color.name === 'glowGradient'))
const styledPromo = compileUIKit({ ...fidelityScreen, styles: { 'S:w': { name: 'Surface/Primary', styleType: 'FILL' } }, root: { ...fidelityScreen.root, styles: { fill: 'S:w' }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] } }, 'PromoView', { deploymentTarget: 13 })
assert.ok(styledPromo.colors.some(color => color.name === 'surfacePrimary'))
assert.match(styledPromo.files.find(file => file.path === 'UIKit-Code/PromoView/PromoView.swift').content, /UIColor\(named: "surfacePrimary"\)/)

console.log('✓ color names from Figma styles / usage passed')
