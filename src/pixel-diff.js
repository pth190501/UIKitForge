// So sánh pixel định lượng giữa preview đã raster hoá và ảnh tham chiếu Figma.
// Thuật toán độc lập DOM/canvas (chỉ thao tác mảng RGBA phẳng) để test được bằng Node thuần,
// UI (main.js/preview.js) chịu trách nhiệm raster DOM/ảnh ra ImageData rồi gọi hàm này.

const DEFAULT_THRESHOLD = 24 // khoảng cách màu tối đa (0-441, theo Euclidean trên RGB) coi là "khớp"

export function diffImageData(a, b, width, height, options = {}) {
  if (!a || !b) throw new Error('diffImageData requires two RGBA buffers.')
  const expectedLength = width * height * 4
  if (a.length !== expectedLength || b.length !== expectedLength) {
    throw new Error(`diffImageData buffer length mismatch: expected ${expectedLength}, got ${a.length}/${b.length}.`)
  }

  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD
  const diffMap = new Uint8ClampedArray(expectedLength)
  let diffPixels = 0
  let comparedPixels = 0

  for (let i = 0; i < expectedLength; i += 4) {
    const aAlpha = a[i + 3]
    const bAlpha = b[i + 3]
    // Bỏ qua pixel trong suốt ở cả hai bên (nền canvas ngoài khung artboard).
    if (aAlpha === 0 && bAlpha === 0) continue
    comparedPixels++

    const dr = a[i] - b[i]
    const dg = a[i + 1] - b[i + 1]
    const db = a[i + 2] - b[i + 2]
    const da = aAlpha - bAlpha
    const distance = Math.sqrt(dr * dr + dg * dg + db * db + da * da)

    if (distance > threshold) {
      diffPixels++
      diffMap[i] = 255
      diffMap[i + 1] = 0
      diffMap[i + 2] = 64
      diffMap[i + 3] = Math.min(255, Math.round((distance / 441) * 255) + 96)
    }
  }

  const diffPercent = comparedPixels ? Number(((diffPixels / comparedPixels) * 100).toFixed(2)) : 0
  return { diffPercent, matchPercent: Number((100 - diffPercent).toFixed(2)), diffPixels, comparedPixels, width, height, diffMap }
}

export function diffSeverity(diffPercent) {
  if (diffPercent <= 2) return 'excellent'
  if (diffPercent <= 8) return 'good'
  if (diffPercent <= 20) return 'fair'
  return 'poor'
}
