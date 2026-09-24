import assert from 'node:assert/strict'
import { createColorRegistry } from '../src/color-registry.js'

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
