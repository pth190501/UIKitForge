import { compileUIKit as compileCore } from './compiler-core.js'

export function compileUIKit(figmaData, requestedRootClass = '') {
  const result = compileCore(figmaData, requestedRootClass)
  const rawNodes = new Map()
  walkRaw(figmaData.root, node => rawNodes.set(node.id, node))

  hydrateComponentPreviews(result.previewRoot, rawNodes)

  result.componentPreviews = Object.fromEntries(
    (result.components || []).map(component => {
      const raw = findFirstInstance(figmaData.root, component.componentId)
      return [component.className, raw ? rawToPreview(raw, null) : null]
    })
  )

  return result
}

function hydrateComponentPreviews(node, rawNodes) {
  if (!node) return

  if (node.kind === 'component' && node.figmaId) {
    const raw = rawNodes.get(node.figmaId)
    if (raw) {
      node.previewChildren = (raw.children || [])
        .filter(child => child.visible !== false)
        .map(child => rawToPreview(child, raw))
    }
  }

  for (const child of node.children || []) {
    hydrateComponentPreviews(child, rawNodes)
  }
}

function rawToPreview(node, parent) {
  const abs = node.absoluteBoundingBox || node.absoluteRenderBounds || fallbackBounds(node)
  const parentAbs = parent?.absoluteBoundingBox || parent?.absoluteRenderBounds || null
  const frame = {
    x: parentAbs ? round(abs.x - parentAbs.x) : 0,
    y: parentAbs ? round(abs.y - parentAbs.y) : 0,
    width: round(abs.width || 1),
    height: round(abs.height || 1)
  }

  const kind = node.type === 'TEXT' ? 'label' : hasImageFill(node) ? 'image' : 'view'
  const preview = {
    id: `PV-${String(node.id || Math.random()).replace(/[^A-Za-z0-9]/g, '')}`,
    figmaId: node.id || '',
    name: node.name || kind,
    type: node.type,
    kind,
    className: null,
    outlet: sanitizeOutletName(node.name || kind),
    frame,
    constraints: inferConstraints(node, parent, frame),
    text: node.type === 'TEXT' ? String(node.characters || '') : '',
    style: extractStyle(node),
    children: []
  }

  preview.children = (node.children || [])
    .filter(child => child.visible !== false)
    .map(child => rawToPreview(child, node))

  dedupeOutlets(preview)
  return preview
}

function extractStyle(node) {
  const fill = firstSolid(node.fills)
  const stroke = firstSolid(node.strokes)
  const effect = (node.effects || []).find(item => item?.visible !== false && item?.type === 'DROP_SHADOW')
  const textStyle = node.style || {}
  const radius = Number.isFinite(node.cornerRadius)
    ? node.cornerRadius
    : Array.isArray(node.rectangleCornerRadii)
      ? Math.max(...node.rectangleCornerRadii)
      : 0

  return {
    background: paintToRgba(fill),
    textColor: node.type === 'TEXT' ? paintToRgba(fill) || 'rgba(0, 0, 0, 1)' : null,
    borderColor: paintToRgba(stroke),
    borderWidth: node.strokeWeight || 0,
    radius: round(radius || 0),
    opacity: node.opacity == null ? 1 : node.opacity,
    fontSize: round(textStyle.fontSize || 14),
    fontFamily: textStyle.fontFamily || 'System',
    fontWeight: normalizeFontWeight(textStyle.fontWeight || 400),
    lineHeight: round(textStyle.lineHeightPx || 0),
    textAlign: String(textStyle.textAlignHorizontal || 'LEFT').toLowerCase(),
    numberOfLines: textStyle.textAutoResize === 'HEIGHT' ? 0 : 1,
    shadow: effect ? {
      x: round(effect.offset?.x || 0),
      y: round(effect.offset?.y || 0),
      blur: round(effect.radius || 0),
      spread: round(effect.spread || 0),
      color: colorToRgba(effect.color)
    } : null
  }
}

function inferConstraints(node, parent, frame) {
  if (!parent) return []
  const parentBox = parent.absoluteBoundingBox || parent.absoluteRenderBounds || fallbackBounds(parent)
  const right = round(Math.max(0, parentBox.width - frame.x - frame.width))
  const bottom = round(Math.max(0, parentBox.height - frame.y - frame.height))
  const centerX = round(frame.x + frame.width / 2 - parentBox.width / 2)
  const centerY = round(frame.y + frame.height / 2 - parentBox.height / 2)
  const source = node.constraints || {}
  const horizontal = source.horizontal || 'LEFT'
  const vertical = source.vertical || 'TOP'
  const result = []

  if (horizontal === 'RIGHT') result.push({ axis: 'h', type: 'trailing', constant: right }, { axis: 'h', type: 'width', constant: frame.width })
  else if (horizontal === 'LEFT_RIGHT') result.push({ axis: 'h', type: 'leading', constant: frame.x }, { axis: 'h', type: 'trailing', constant: right })
  else if (horizontal === 'CENTER') result.push({ axis: 'h', type: 'centerX', constant: centerX }, { axis: 'h', type: 'width', constant: frame.width })
  else result.push({ axis: 'h', type: 'leading', constant: frame.x }, { axis: 'h', type: 'width', constant: frame.width })

  if (vertical === 'BOTTOM') result.push({ axis: 'v', type: 'bottom', constant: bottom }, { axis: 'v', type: 'height', constant: frame.height })
  else if (vertical === 'TOP_BOTTOM') result.push({ axis: 'v', type: 'top', constant: frame.y }, { axis: 'v', type: 'bottom', constant: bottom })
  else if (vertical === 'CENTER') result.push({ axis: 'v', type: 'centerY', constant: centerY }, { axis: 'v', type: 'height', constant: frame.height })
  else result.push({ axis: 'v', type: 'top', constant: frame.y }, { axis: 'v', type: 'height', constant: frame.height })

  return result
}

function findFirstInstance(root, componentId) {
  let found = null
  walkRaw(root, node => {
    if (!found && node.type === 'INSTANCE' && node.componentId === componentId) found = node
  })
  return found
}

function walkRaw(node, visitor) {
  if (!node) return
  visitor(node)
  for (const child of node.children || []) walkRaw(child, visitor)
}

function hasImageFill(node) {
  return (node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE')
}

function firstSolid(paints = []) {
  return (paints || []).find(paint => paint?.visible !== false && paint?.type === 'SOLID') || null
}

function paintToRgba(paint) {
  if (!paint?.color) return null
  const { r = 0, g = 0, b = 0, a = 1 } = paint.color
  const alpha = paint.opacity == null ? a : a * paint.opacity
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(alpha.toFixed(3))})`
}

function colorToRgba(color) {
  if (!color) return null
  const { r = 0, g = 0, b = 0, a = 1 } = color
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(a.toFixed(3))})`
}

function sanitizeOutletName(value) {
  const parts = String(value || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  let result = parts
    .map((part, index) => index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'generatedView'

  if (/^[0-9]/.test(result)) result = `view${result}`
  return result
}

function dedupeOutlets(root) {
  const used = new Map()
  const nodes = []
  const visit = node => {
    nodes.push(node)
    for (const child of node.children || []) visit(child)
  }
  visit(root)

  for (const node of nodes.slice(1)) {
    const base = node.outlet
    const count = (used.get(base) || 0) + 1
    used.set(base, count)
    if (count > 1) node.outlet = `${base}${count}`
  }
}

function normalizeFontWeight(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(100, Math.min(900, number)) : 400
}

function fallbackBounds(node) {
  const box = node.size || {}
  return { x: 0, y: 0, width: box.x || 1, height: box.y || 1 }
}

function round(value) {
  return Number(Number(value || 0).toFixed(2))
}
