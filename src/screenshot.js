const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm'

export async function analyzeScreenshot(file, options = {}) {
  if (!file) throw new Error('Please choose a screenshot.')
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  onProgress({ stage: 'decode', progress: 0.05, message: 'Reading screenshot…' })

  const image = await decodeImage(file)
  const width = image.width || image.naturalWidth
  const height = image.height || image.naturalHeight
  if (!width || !height) throw new Error('Could not read screenshot dimensions.')

  const analysisScale = Math.min(1, 720 / Math.max(width, height))
  const analysisWidth = Math.max(1, Math.round(width * analysisScale))
  const analysisHeight = Math.max(1, Math.round(height * analysisScale))
  const canvas = document.createElement('canvas')
  canvas.width = analysisWidth
  canvas.height = analysisHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, analysisWidth, analysisHeight)
  const dataUrl = canvasToDataUrl(image, width, height)

  onProgress({ stage: 'vision', progress: 0.18, message: 'Detecting cards, buttons and image regions…' })
  const imageData = ctx.getImageData(0, 0, analysisWidth, analysisHeight)
  const background = estimateBackground(imageData)
  const regions = detectRegions(imageData, background, analysisScale)

  onProgress({ stage: 'ocr', progress: 0.35, message: 'Reading visible text…' })
  const ocr = await detectText(dataUrl, image, analysisScale, onProgress)

  onProgress({ stage: 'hierarchy', progress: 0.86, message: 'Inferring UIKit hierarchy and Auto Layout…' })
  const result = buildScreenshotFigmaData({
    width,
    height,
    background,
    regions,
    textLines: ocr.lines,
    filename: file.name || 'screenshot.png',
    sourceDataUrl: dataUrl,
    ocrEngine: ocr.engine
  })
  onProgress({ stage: 'done', progress: 1, message: 'Screenshot analysis complete.' })
  return result
}

export function buildScreenshotFigmaData({
  width,
  height,
  background = { r: 1, g: 1, b: 1, a: 1 },
  regions = [],
  textLines = [],
  filename = 'screenshot.png',
  sourceDataUrl = null,
  ocrEngine = 'heuristic'
}) {
  const safeWidth = Math.max(1, Math.round(width || 390))
  const safeHeight = Math.max(1, Math.round(height || 844))
  const imageMap = {}
  const assets = []
  const regionNodes = regions
    .filter(region => region.width >= 8 && region.height >= 8)
    .slice(0, 28)
    .map((region, index) => {
      const id = `shot:region:${index + 1}`
      const imageRef = region.cropDataUrl ? `shot-image-${index + 1}` : null
      if (imageRef) imageMap[imageRef] = region.cropDataUrl
      if (imageRef) assets.push({ name: `UIKitForgeCrop${index + 1}`, dataUrl: region.cropDataUrl, filename: `crop-${index + 1}.png` })
      return {
        id,
        type: 'RECTANGLE',
        name: region.role === 'button' ? `Detected Button ${index + 1}` : region.role === 'image' ? `Detected Image ${index + 1}` : `Detected Container ${index + 1}`,
        absoluteBoundingBox: rect(region),
        fills: imageRef
          ? [{ type: 'IMAGE', imageRef, scaleMode: 'FILL' }]
          : [{ type: 'SOLID', color: normalizeColor(region.color || background) }],
        cornerRadius: Number.isFinite(region.radius) ? region.radius : inferRadius(region),
        constraints: inferEdgeConstraints(region, safeWidth, safeHeight),
        children: []
      }
    })

  const textNodes = textLines
    .filter(line => line && line.text && line.width >= 6 && line.height >= 5)
    .slice(0, 80)
    .map((line, index) => ({
      id: `shot:text:${index + 1}`,
      type: 'TEXT',
      name: `Detected Text ${index + 1}`,
      characters: cleanText(line.text),
      absoluteBoundingBox: rect(line),
      fills: [{ type: 'SOLID', color: normalizeColor(line.color || { r: 0.08, g: 0.1, b: 0.16, a: 1 }) }],
      style: {
        fontSize: Math.max(9, Math.min(42, Number(line.fontSize || Math.max(10, line.height * 0.72)))),
        fontWeight: Number(line.fontWeight || 500),
        lineHeightPx: Math.max(line.height, Number(line.lineHeight || line.height)),
        textAlignHorizontal: line.textAlign || 'LEFT',
        textAutoResize: 'WIDTH_AND_HEIGHT'
      },
      constraints: inferEdgeConstraints(line, safeWidth, safeHeight)
    }))

  for (const textNode of textNodes) {
    const owner = smallestContainingRegion(regionNodes, textNode.absoluteBoundingBox)
    if (owner) owner.children.push(textNode)
  }
  const nestedTextIds = new Set(regionNodes.flatMap(node => node.children.map(child => child.id)))
  const rootText = textNodes.filter(node => !nestedTextIds.has(node.id))
  const children = [...regionNodes, ...rootText].sort((a, b) => {
    const ay = a.absoluteBoundingBox?.y || 0
    const by = b.absoluteBoundingBox?.y || 0
    return ay - by || (a.absoluteBoundingBox?.x || 0) - (b.absoluteBoundingBox?.x || 0)
  })

  const warnings = [
    `Image-only mode inferred ${regionNodes.length} visual regions and ${textNodes.length} text layers from ${filename}.`,
    `OCR engine: ${ocrEngine}. Screenshot-derived hierarchy is heuristic because pixels do not contain Figma constraints or component metadata.`
  ]
  if (textNodes.some(node => /^Text \d+$/i.test(node.characters))) {
    warnings.push('Some text could not be OCR-read and was emitted as editable placeholder UILabel content.')
  }
  if (assets.length) warnings.push(`${assets.length} complex visual region(s) are preserved as cropped image assets in Browser Preview/export metadata.`)

  return {
    name: filename.replace(/\.[^.]+$/, '') || 'Screenshot',
    source: { mode: 'screenshot', filename, width: safeWidth, height: safeHeight, ocrEngine },
    components: {},
    componentSets: {},
    styles: {},
    imageMap,
    assets,
    sourceDataUrl,
    analysisWarnings: warnings,
    root: {
      id: 'shot:root',
      type: 'FRAME',
      name: 'Screenshot Root',
      absoluteBoundingBox: { x: 0, y: 0, width: safeWidth, height: safeHeight },
      fills: [{ type: 'SOLID', color: normalizeColor(background) }],
      clipsContent: true,
      children
    }
  }
}

async function detectText(dataUrl, image, analysisScale, onProgress) {
  if (typeof window !== 'undefined' && 'TextDetector' in window) {
    try {
      const detector = new window.TextDetector()
      const rows = await detector.detect(image)
      const lines = rows.map((row, index) => {
        const box = row.boundingBox || row.bounds || {}
        return scaleDetectedText({
          text: row.rawValue || row.text || `Text ${index + 1}`,
          x: box.x || 0,
          y: box.y || 0,
          width: box.width || 1,
          height: box.height || 1
        }, 1)
      })
      if (lines.length) return { engine: 'browser TextDetector', lines }
    } catch {}
  }

  try {
    onProgress({ stage: 'ocr', progress: 0.46, message: 'Loading client-side OCR…' })
    const mod = await import(/* @vite-ignore */ OCR_CDN)
    const api = mod.default || mod
    const recognize = mod.recognize || api.recognize
    if (typeof recognize === 'function') {
      const result = await recognize(dataUrl, 'eng+vie', {
        logger(message) {
          if (message.status === 'recognizing text' && Number.isFinite(message.progress)) {
            onProgress({ stage: 'ocr', progress: 0.46 + message.progress * 0.32, message: `OCR ${Math.round(message.progress * 100)}%…` })
          }
        }
      })
      const rawLines = result?.data?.lines || []
      const lines = rawLines.map((line, index) => {
        const box = line.bbox || {}
        return {
          text: cleanText(line.text) || `Text ${index + 1}`,
          x: box.x0 || 0,
          y: box.y0 || 0,
          width: Math.max(1, (box.x1 || 1) - (box.x0 || 0)),
          height: Math.max(1, (box.y1 || 1) - (box.y0 || 0)),
          fontSize: Math.max(10, ((box.y1 || 1) - (box.y0 || 0)) * 0.74),
          fontWeight: Number(line.confidence || line.conf || 0) > 80 ? 500 : 400
        }
      })
      if (lines.length) return { engine: 'Tesseract.js', lines }
    }
  } catch {}

  const fallback = heuristicTextRows(image, analysisScale)
  return { engine: 'pixel heuristic', lines: fallback }
}

function heuristicTextRows(image, analysisScale) {
  const w = Math.max(1, Math.round((image.width || image.naturalWidth) * analysisScale))
  const h = Math.max(1, Math.round((image.height || image.naturalHeight) * analysisScale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  const rowEnergy = new Array(h).fill(0)
  for (let y = 1; y < h - 1; y++) {
    let energy = 0
    for (let x = 1; x < w - 1; x += 2) {
      const p = pixel(data, x, y)
      const q = pixel(data, x + 1, y)
      if (colorDistance(p, q) > 30) energy++
    }
    rowEnergy[y] = energy
  }
  const threshold = Math.max(5, w / 50)
  const bands = []
  let start = -1
  for (let y = 0; y <= h; y++) {
    if (y < h && rowEnergy[y] >= threshold) {
      if (start < 0) start = y
    } else if (start >= 0) {
      if (y - start >= 5 && y - start <= 48) bands.push([start, y])
      start = -1
    }
  }
  const inv = 1 / analysisScale
  return bands.slice(0, 32).map(([y0, y1], index) => ({
    text: `Text ${index + 1}`,
    x: Math.round(w * 0.06 * inv),
    y: Math.round(y0 * inv),
    width: Math.round(w * 0.88 * inv),
    height: Math.max(8, Math.round((y1 - y0) * inv)),
    fontSize: Math.max(10, Math.round((y1 - y0) * inv * 0.72)),
    fontWeight: 400
  }))
}

function detectRegions(imageData, background, analysisScale) {
  const step = Math.max(3, Math.round(Math.min(imageData.width, imageData.height) / 120))
  const gw = Math.ceil(imageData.width / step)
  const gh = Math.ceil(imageData.height / step)
  const active = new Uint8Array(gw * gh)
  const colors = new Array(gw * gh)

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const avg = averagePatch(imageData, gx * step, gy * step, step)
      const idx = gy * gw + gx
      colors[idx] = avg
      const dist = colorDistance(avg, background)
      active[idx] = dist > 24 ? 1 : 0
    }
  }

  const seen = new Uint8Array(active.length)
  const components = []
  for (let i = 0; i < active.length; i++) {
    if (!active[i] || seen[i]) continue
    const stack = [i]
    seen[i] = 1
    let minX = gw, minY = gh, maxX = 0, maxY = 0, count = 0
    const samples = []
    while (stack.length) {
      const idx = stack.pop()
      const x = idx % gw
      const y = Math.floor(idx / gw)
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++
      if (samples.length < 80) samples.push(colors[idx])
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
        const ni = ny * gw + nx
        if (active[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni) }
      }
    }
    const bw = (maxX - minX + 1) * step
    const bh = (maxY - minY + 1) * step
    const areaRatio = (bw * bh) / Math.max(1, imageData.width * imageData.height)
    if (count < 5 || bw < 12 || bh < 10 || areaRatio > 0.88) continue
    const density = count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1))
    if (bh < 26 && density < 0.55) continue
    components.push({
      x: minX * step,
      y: minY * step,
      width: Math.min(imageData.width - minX * step, bw),
      height: Math.min(imageData.height - minY * step, bh),
      color: averageColors(samples),
      density,
      areaRatio
    })
  }

  const inv = 1 / analysisScale
  return suppressNestedNoise(components)
    .sort((a, b) => b.areaRatio - a.areaRatio)
    .slice(0, 28)
    .map(region => {
      const variance = patchVariance(imageData, region.x, region.y, region.width, region.height)
      const role = variance > 1550 && region.areaRatio > 0.018 ? 'image' : region.height >= 28 && region.height <= 72 && region.width > region.height * 2.2 ? 'button' : 'container'
      const scaled = {
        x: Math.round(region.x * inv),
        y: Math.round(region.y * inv),
        width: Math.round(region.width * inv),
        height: Math.round(region.height * inv),
        color: region.color,
        role,
        variance,
        radius: role === 'button' ? Math.min(22, Math.round(region.height * inv / 2)) : 12
      }
      if (role === 'image') scaled.cropDataUrl = cropDataUrl(imageData, region)
      return scaled
    })
}

function suppressNestedNoise(regions) {
  const sorted = [...regions].sort((a, b) => b.width * b.height - a.width * a.height)
  const kept = []
  for (const region of sorted) {
    const duplicate = kept.some(other => iou(region, other) > 0.82)
    if (!duplicate) kept.push(region)
  }
  return kept
}

function cropDataUrl(imageData, region) {
  try {
    const source = document.createElement('canvas')
    source.width = imageData.width
    source.height = imageData.height
    source.getContext('2d').putImageData(imageData, 0, 0)
    const crop = document.createElement('canvas')
    crop.width = Math.max(1, Math.round(region.width))
    crop.height = Math.max(1, Math.round(region.height))
    crop.getContext('2d').drawImage(source, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height)
    return crop.toDataURL('image/png')
  } catch { return null }
}

function canvasToDataUrl(image, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const dataUrl = await fileToDataUrl(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode screenshot.'))
    img.src = dataUrl
  })
}

function estimateBackground(imageData) {
  const patches = [
    averagePatch(imageData, 0, 0, 12),
    averagePatch(imageData, imageData.width - 12, 0, 12),
    averagePatch(imageData, 0, imageData.height - 12, 12),
    averagePatch(imageData, imageData.width - 12, imageData.height - 12, 12)
  ]
  return medianColor(patches)
}

function averagePatch(imageData, x0, y0, size) {
  const x1 = Math.max(0, Math.min(imageData.width, x0))
  const y1 = Math.max(0, Math.min(imageData.height, y0))
  const x2 = Math.max(x1 + 1, Math.min(imageData.width, x1 + size))
  const y2 = Math.max(y1 + 1, Math.min(imageData.height, y1 + size))
  let r = 0, g = 0, b = 0, a = 0, n = 0
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
    const i = (y * imageData.width + x) * 4
    r += imageData.data[i]; g += imageData.data[i + 1]; b += imageData.data[i + 2]; a += imageData.data[i + 3]; n++
  }
  return { r: r / n / 255, g: g / n / 255, b: b / n / 255, a: a / n / 255 }
}

function patchVariance(imageData, x0, y0, width, height) {
  const step = Math.max(2, Math.round(Math.min(width, height) / 16))
  const samples = []
  for (let y = y0; y < y0 + height; y += step) for (let x = x0; x < x0 + width; x += step) samples.push(pixel(imageData, x, y))
  const avg = averageColors(samples)
  if (!samples.length) return 0
  return samples.reduce((sum, color) => sum + colorDistanceSquared(color, avg), 0) / samples.length
}

function pixel(imageData, x, y) {
  const px = Math.max(0, Math.min(imageData.width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(imageData.height - 1, Math.round(y)))
  const i = (py * imageData.width + px) * 4
  return { r: imageData.data[i] / 255, g: imageData.data[i + 1] / 255, b: imageData.data[i + 2] / 255, a: imageData.data[i + 3] / 255 }
}

function averageColors(colors) {
  if (!colors.length) return { r: 1, g: 1, b: 1, a: 1 }
  const sum = colors.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b, a: acc.a + (c.a ?? 1) }), { r: 0, g: 0, b: 0, a: 0 })
  return { r: sum.r / colors.length, g: sum.g / colors.length, b: sum.b / colors.length, a: sum.a / colors.length }
}

function medianColor(colors) {
  const sort = key => colors.map(c => c[key]).sort((a, b) => a - b)[Math.floor(colors.length / 2)]
  return { r: sort('r'), g: sort('g'), b: sort('b'), a: sort('a') }
}

function colorDistance(a, b) { return Math.sqrt(colorDistanceSquared(a, b)) }
function colorDistanceSquared(a, b) {
  const dr = ((a.r ?? 0) - (b.r ?? 0)) * 255
  const dg = ((a.g ?? 0) - (b.g ?? 0)) * 255
  const db = ((a.b ?? 0) - (b.b ?? 0)) * 255
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
}

function scaleDetectedText(item, factor) {
  return { ...item, x: item.x * factor, y: item.y * factor, width: item.width * factor, height: item.height * factor, fontSize: Math.max(9, item.height * factor * 0.72), fontWeight: 500 }
}

function rect(value) {
  return { x: round(value.x), y: round(value.y), width: Math.max(1, round(value.width)), height: Math.max(1, round(value.height)) }
}

function smallestContainingRegion(regions, box) {
  return regions
    .filter(node => contains(node.absoluteBoundingBox, box))
    .sort((a, b) => area(a.absoluteBoundingBox) - area(b.absoluteBoundingBox))[0] || null
}

function contains(outer, inner) {
  const pad = 2
  return inner.x >= outer.x - pad && inner.y >= outer.y - pad && inner.x + inner.width <= outer.x + outer.width + pad && inner.y + inner.height <= outer.y + outer.height + pad
}
function area(box) { return Math.max(0, box.width) * Math.max(0, box.height) }
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection)
}

function inferRadius(region) { return region.role === 'button' ? Math.min(region.height / 2, 22) : Math.min(16, Math.max(0, region.height * 0.12)) }
function inferEdgeConstraints(box, width, height) {
  const right = Math.max(0, width - box.x - box.width)
  const bottom = Math.max(0, height - box.y - box.height)
  return {
    horizontal: box.width / width > 0.72 && box.x > 0 && right > 0 ? 'LEFT_RIGHT' : Math.abs(box.x + box.width / 2 - width / 2) < 3 ? 'CENTER' : 'LEFT',
    vertical: box.height / height > 0.72 && box.y > 0 && bottom > 0 ? 'TOP_BOTTOM' : 'TOP'
  }
}
function normalizeColor(c) { return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a ?? 1) } }
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)) }
function cleanText(text) { return String(text || '').replace(/\s+/g, ' ').trim() }
function round(value) { return Number(Number(value || 0).toFixed(2)) }
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
