import assert from 'node:assert/strict'
import { diffImageData, diffSeverity } from '../src/pixel-diff.js'

function solidBuffer(width, height, [r, g, b, a]) {
  const buffer = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = r; buffer[i + 1] = g; buffer[i + 2] = b; buffer[i + 3] = a
  }
  return buffer
}

// Hai buffer giống hệt nhau -> 0% diff, 100% match.
const identicalA = solidBuffer(4, 4, [10, 20, 30, 255])
const identicalB = solidBuffer(4, 4, [10, 20, 30, 255])
const identical = diffImageData(identicalA, identicalB, 4, 4)
assert.equal(identical.diffPercent, 0)
assert.equal(identical.matchPercent, 100)
assert.equal(identical.diffPixels, 0)
assert.equal(identical.comparedPixels, 16)

// Hai buffer hoàn toàn khác màu (đen vs trắng) -> 100% diff pixel nằm ngoài threshold.
const blackBuffer = solidBuffer(2, 2, [0, 0, 0, 255])
const whiteBuffer = solidBuffer(2, 2, [255, 255, 255, 255])
const opposite = diffImageData(blackBuffer, whiteBuffer, 2, 2)
assert.equal(opposite.diffPercent, 100)
assert.equal(opposite.diffPixels, 4)

// Pixel trong suốt ở cả hai bên (ngoài artboard) không tính vào comparedPixels.
const transparentA = new Uint8ClampedArray([0, 0, 0, 0, 10, 20, 30, 255])
const transparentB = new Uint8ClampedArray([0, 0, 0, 0, 10, 20, 30, 255])
const transparentResult = diffImageData(transparentA, transparentB, 2, 1)
assert.equal(transparentResult.comparedPixels, 1)
assert.equal(transparentResult.diffPixels, 0)

// Sai lệch nhỏ trong ngưỡng threshold mặc định vẫn được coi là khớp.
const near = diffImageData(solidBuffer(1, 1, [100, 100, 100, 255]), solidBuffer(1, 1, [105, 100, 100, 255]), 1, 1)
assert.equal(near.diffPixels, 0)

// diffMap đánh dấu đúng pixel lệch màu.
const half = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
const halfRef = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])
const halfResult = diffImageData(half, halfRef, 2, 1)
assert.equal(halfResult.diffPixels, 1)
assert.equal(halfResult.diffPercent, 50)
assert.equal(halfResult.diffMap[4], 255) // R kênh của pixel lệch được tô đỏ
assert.equal(halfResult.diffMap[0], 0)   // pixel khớp giữ nguyên 0

// Buffer sai kích thước phải throw thay vì âm thầm so sai.
assert.throws(() => diffImageData(new Uint8ClampedArray(4), new Uint8ClampedArray(8), 1, 1))

// diffSeverity map đúng ngưỡng.
assert.equal(diffSeverity(0), 'excellent')
assert.equal(diffSeverity(5), 'good')
assert.equal(diffSeverity(15), 'fair')
assert.equal(diffSeverity(50), 'poor')

console.log('✓ pixel-diff quantitative comparison passed')
