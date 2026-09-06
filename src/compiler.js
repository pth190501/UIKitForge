import { compileUIKit as compileCore } from './compiler-core.js'
import { figmaPaintToCss, firstVisiblePaint } from './figma.js'
import { applySwiftPreview } from './preview.js'

export function compileUIKit(figmaData, requestedRootClass = '') {
  const result = compileCore(figmaData, requestedRootClass)
  const rawNodes = new Map()
  walkRaw(figmaData.root, node => rawNodes.set(node.id, node))
  const imageMap = figmaData.imageMap || {}

  hydrateRichPreview(result.previewRoot, rawNodes, imageMap)
  hydrateComponentPreviews(result.previewRoot, rawNodes, imageMap)

  result.componentPreviews = Object.fromEntries(
    (result.components || []).map(component => {
      const raw = findFirstInstance(figmaData.root, component.componentId)
      if (!raw) return [component.className, null]
      const preview = rawToPreview(raw, null, imageMap)
      dedupeOutlets(preview)
      return [component.className, preview]
    })
  )

  if (figmaData.imageFillWarning) result.warnings.push(figmaData.imageFillWarning)
  bindComponentSwiftLivePreview(result)
  return result
}

function bindComponentSwiftLivePreview(result) {
  for (const file of result.files || []) {
    if (file.language !== 'swift' || file.kind !== 'component') continue

    const className = String(file.name || '').replace(/\.swift$/i, '')
    const basePreview = result.componentPreviews?.[className]
    if (!className || !basePreview) continue

    let source = String(file.content || '')

    const sync = () => {
      const livePreview = applySwiftPreview(basePreview, source)
      result.componentPreviews[className] = livePreview
      syncComponentInstances(result.previewRoot, className, livePreview)
      schedulePreviewRefresh()
    }

    Object.defineProperty(file, 'content', {
      configurable: true,
      enumerable: true,
      get() { return source },
      set(value) {
        source = String(value ?? '')
        sync()
      }
    })

    sync()
  }
}

function syncComponentInstances(root, className, componentPreview) {
  if (!root || !componentPreview) return

  if (root.kind === 'component' && root.className === className) {
    root.style = { ...(root.style || {}), ...(cloneValue(componentPreview.style) || {}) }
    root.layout = cloneValue(componentPreview.layout || root.layout || {})
    root.meta = { ...(root.meta || {}), ...(cloneValue(componentPreview.meta) || {}) }

    if (componentPreview.hidden == null) delete root.hidden
    else root.hidden = componentPreview.hidden

    root.previewChildren = cloneValue(componentPreview.children || [])
  }

  for (const child of root.children || []) syncComponentInstances(child, className, componentPreview)
}

function schedulePreviewRefresh() {
  if (typeof window === 'undefined') return
  const refresh = () => {
    try { window.dispatchEvent(new CustomEvent('uikitforge:preview-refresh')) } catch {}
  }
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(refresh)
  else setTimeout(refresh, 0)
}

function cloneValue(value) {
  if (value == null) return value
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

function hydrateRichPreview(node, rawNodes, imageMap) {
  if (!node) return
  const raw = node.figmaId ? rawNodes.get(node.figmaId) : null
  if (raw) {
    node.style = { ...(node.style || {}), ...extractStyle(raw, imageMap) }
    node.layout = extractLayout(raw)
    node.meta = {
      ...(node.meta || {}),
      layoutPositioning: raw.layoutPositioning || node.meta?.layoutPositioning || 'AUTO',
      clipsContent: Boolean(raw.clipsContent),
      blendMode: raw.blendMode || 'PASS_THROUGH'
    }
  }
  for (const child of node.children || []) hydrateRichPreview(child, rawNodes, imageMap)
}

function hydrateComponentPreviews(node, rawNodes, imageMap) {
  if (!node) return

  if (node.kind === 'component' && node.figmaId) {
    const raw = rawNodes.get(node.figmaId)
    if (raw) {
      node.previewChildren = (raw.children || [])
        .filter(child => child.visible !== false)
        .map(child => rawToPreview(child, raw, imageMap))
      dedupeOutlets({ children: node.previewChildren, outlet: '__root' })
    }
  }

  for (const child of node.children || []) hydrateComponentPreviews(child, rawNodes, imageMap)
}

function rawToPreview(node, parent, imageMap) {
  const abs = node.absoluteBoundingBox || node.absoluteRenderBounds || fallbackBounds(node)
  const parentAbs = parent?.absoluteBoundingBox || parent?.absoluteRenderBounds || null
  const frame = {
    x: parentAbs ? round(abs.x - parentAbs.x) : 0,
    y: parentAbs ? round(abs.y - parentAbs.y) : 0,
    width: round(abs.width || 1),
    height: round(abs.height || 1)
  }

  const visibleChildren = (node.children || []).filter(child => child.visible !== false)
  const kind = node.type === 'TEXT'
    ? 'label'
    : hasImageFill(node) && visibleChildren.length === 0
      ? 'image'
      : 'view'

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
    style: extractStyle(node, imageMap),
    layout: extractLayout(node),
    meta: {
      hasImageFill: hasImageFill(node),
      preservesChildrenOverImageFill: hasImageFill(node) && visibleChildren.length > 0,
      layoutPositioning: node.layoutPositioning || 'AUTO',
      clipsContent: Boolean(node.clipsContent),
      blendMode: node.blendMode || 'PASS_THROUGH'
    },
    children: []
  }

  preview.children = visibleChildren.map(child => rawToPreview(child, node, imageMap))
  return preview
}

function extractStyle(node, imageMap = {}) {
  const visibleFills = (node.fills || []).filter(item => item?.visible !== false)
  const visibleStrokes = (node.strokes || []).filter(item => item?.visible !== false)
  const firstFill = firstVisiblePaint(visibleFills)
  const solidTextFill = visibleFills.find(item => item.type === 'SOLID')
  const stroke = visibleStrokes.find(item => item.type === 'SOLID')
  const imagePaint = visibleFills.find(item => item.type === 'IMAGE' && item.imageRef)
  const effect = (node.effects || []).find(item => item?.visible !== false && item?.type === 'DROP_SHADOW')
  const textStyle = node.style || {}
  const radius = Number.isFinite(node.cornerRadius)
    ? node.cornerRadius
    : Array.isArray(node.rectangleCornerRadii)
      ? Math.max(...node.rectangleCornerRadii)
      : 0

  return {
    background: firstFill?.type === 'IMAGE' ? null : figmaPaintToCss(firstFill),
    textColor: node.type === 'TEXT' ? figmaPaintToCss(solidTextFill) || 'rgba(0, 0, 0, 1)' : null,
    borderColor: figmaPaintToCss(stroke),
    borderWidth: round(node.strokeWeight || 0),
    radius: round(radius || 0),
    cornerRadii: Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii.map(round) : null,
    opacity: node.opacity == null ? 1 : node.opacity,
    fontSize: round(textStyle.fontSize || 14),
    fontFamily: textStyle.fontFamily || 'System',
    fontWeight: normalizeFontWeight(textStyle.fontWeight || 400),
    lineHeight: round(textStyle.lineHeightPx || 0),
    letterSpacing: round(textStyle.letterSpacing || 0),
    textAlign: String(textStyle.textAlignHorizontal || 'LEFT').toLowerCase(),
    numberOfLines: textStyle.textAutoResize === 'HEIGHT' || textStyle.textAutoResize === 'WIDTH_AND_HEIGHT' ? 0 : 1,
    imageRef: imagePaint?.imageRef || null,
    imageUrl: imagePaint?.imageRef ? imageMap[imagePaint.imageRef] || null : null,
    imageScaleMode: imagePaint?.scaleMode || null,
    clipsContent: Boolean(node.clipsContent),
    shadow: effect ? {
      x: round(effect.offset?.x || 0),
      y: round(effect.offset?.y || 0),
      blur: round(effect.radius || 0),
      spread: round(effect.spread || 0),
      color: colorToRgba(effect.color)
    } : null
  }
}

function extractLayout(node) {
  return {
    mode: node.layoutMode || 'NONE',
    itemSpacing: round(node.itemSpacing || 0),
    paddingLeft: round(node.paddingLeft || 0),
    paddingRight: round(node.paddingRight || 0),
    paddingTop: round(node.paddingTop || 0),
    paddingBottom: round(node.paddingBottom || 0),
    primaryAxisAlignItems: node.primaryAxisAlignItems || 'MIN',
    counterAxisAlignItems: node.counterAxisAlignItems || 'MIN',
    layoutSizingHorizontal: node.layoutSizingHorizontal || null,
    layoutSizingVertical: node.layoutSizingVertical || null
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
  else if (horizontal === 'LEFT_RIGHT' || horizontal === 'SCALE') result.push({ axis: 'h', type: 'leading', constant: frame.x }, { axis: 'h', type: 'trailing', constant: right })
  else if (horizontal === 'CENTER') result.push({ axis: 'h', type: 'centerX', constant: centerX }, { axis: 'h', type: 'width', constant: frame.width })
  else result.push({ axis: 'h', type: 'leading', constant: frame.x }, { axis: 'h', type: 'width', constant: frame.width })

  if (vertical === 'BOTTOM') result.push({ axis: 'v', type: 'bottom', constant: bottom }, { axis: 'v', type: 'height', constant: frame.height })
  else if (vertical === 'TOP_BOTTOM' || vertical === 'SCALE') result.push({ axis: 'v', type: 'top', constant: frame.y }, { axis: 'v', type: 'bottom', constant: bottom })
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
  const visit = node => {
    for (const child of node.children || []) {
      const base = child.outlet || 'generatedView'
      const count = (used.get(base) || 0) + 1
      used.set(base, count)
      if (count > 1) child.outlet = `${base}${count}`
      visit(child)
    }
  }
  visit(root)
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
