import { findComponentCandidates, firstVisibleSolidPaint } from './figma.js'
import { createColorRegistry } from './color-registry.js'

const VIEW_TYPES = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE',
  'RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'
])

const MIN_DEPLOYMENT_TARGET = 13
const MAX_DEPLOYMENT_TARGET = 18

export function compileUIKit(figmaData, requestedRootClass = '', options = {}) {
  const deploymentTarget = normalizeDeploymentTarget(options.deploymentTarget)
  const warnings = []
  const sourceRoot = pickRenderableRoot(figmaData.root, warnings)
  const rootClass = sanitizeClassName(requestedRootClass || sourceRoot.name || 'GeneratedView', 'GeneratedView')
  const candidates = findComponentCandidates(sourceRoot)
  const componentMap = new Map()
  const usedNames = new Set([rootClass])

  for (const { componentId, node } of candidates.instances) {
    if (node.id === sourceRoot.id) continue
    let className = sanitizeClassName(`${node.name || 'Component'}View`, 'GeneratedComponentView')
    className = uniqueClassName(className, usedNames)
    componentMap.set(componentId, { className, source: node })
  }

  const colorRegistry = createColorRegistry()
  const files = []
  const components = []
  const componentIRs = []
  for (const [componentId, entry] of componentMap.entries()) {
    const ir = buildIR(entry.source, null, componentMap, { skipComponentForNodeId: entry.source.id })
    dedupeOutlets(ir)
    ensureUniqueIds(ir)
    files.push(
      { path: `Components/${entry.className}/${entry.className}.swift`, name: `${entry.className}.swift`, language: 'swift', content: generateSwift(entry.className, ir, colorRegistry), kind: 'component', target: 'uikit-xib' },
      { path: `Components/${entry.className}/${entry.className}.xib`, name: `${entry.className}.xib`, language: 'xml', content: generateXib(entry.className, ir, deploymentTarget), kind: 'component', target: 'uikit-xib' },
      { path: `UIKit-Code/Components/${entry.className}/${entry.className}.swift`, name: `${entry.className}.swift`, language: 'swift', content: generateSwiftProgrammatic(entry.className, ir, colorRegistry), kind: 'component', target: 'uikit-code' }
    )
    components.push({ componentId, className: entry.className, sourceName: entry.source.name || 'Component' })
    componentIRs.push({ className: entry.className, ir })
  }

  const mainIR = buildIR(sourceRoot, null, componentMap, { skipComponentForNodeId: sourceRoot.id })
  dedupeOutlets(mainIR)
  ensureUniqueIds(mainIR)
  files.unshift(
    { path: `${rootClass}/${rootClass}.xib`, name: `${rootClass}.xib`, language: 'xml', content: generateXib(rootClass, mainIR, deploymentTarget), kind: 'main', target: 'uikit-xib' },
    { path: `${rootClass}/${rootClass}.swift`, name: `${rootClass}.swift`, language: 'swift', content: generateSwift(rootClass, mainIR, colorRegistry), kind: 'main', target: 'uikit-xib' },
    { path: `UIKit-Code/${rootClass}/${rootClass}.swift`, name: `${rootClass}.swift`, language: 'swift', content: generateSwiftProgrammatic(rootClass, mainIR, colorRegistry), kind: 'main', target: 'uikit-code' }
  )

  warnings.push(...collectLayoutWarnings(mainIR))
  if (colorRegistry.entries().length) {
    warnings.push('Colors.xcassets was generated with the Dark Appearance set to the same value as Any Appearance (Figma has no dark variant). Edit the color sets in Xcode for a real dark palette.')
  }
  return {
    rootClass, deploymentTarget, sourceRoot, previewRoot: mainIR, files, components, componentIRs,
    colorRegistry, colors: colorRegistry.entries(), warnings: [...new Set(warnings)]
  }
}

function pickRenderableRoot(root, warnings) {
  if (!root) throw new Error('No Figma root node was supplied to the compiler.')

  if (root.type === 'COMPONENT_SET') {
    const variant = (root.children || []).find(child => child.visible !== false && child.type === 'COMPONENT')
    if (variant) {
      warnings.push(`${root.name || 'Component set'} is a Figma component set. UIKitForge compiled its first visible variant instead of flattening every variant into one XIB.`)
      return variant
    }
  }

  if (root.type !== 'DOCUMENT' && root.type !== 'CANVAS') return root
  if (root.type === 'DOCUMENT') {
    const canvas = (root.children || []).find(child => child.type === 'CANVAS')
    const firstVisual = canvas?.children?.find(child => child.visible !== false)
    if (firstVisual) {
      warnings.push('The URL points to a whole Figma file. UIKitForge compiled the first visible top-level frame; use a node-specific Figma URL for deterministic output.')
      return firstVisual
    }
  }

  const first = (root.children || []).find(child => child.visible !== false)
  if (first) {
    warnings.push('The URL points to a Figma page. UIKitForge compiled the first visible top-level node; use a node-specific Figma URL for deterministic output.')
    return first
  }
  return root
}

function buildIR(node, parentNode, componentMap, options = {}) {
  const abs = bounds(node)
  const parentAbs = parentNode ? bounds(parentNode) : null
  const frame = {
    x: parentAbs ? round(abs.x - parentAbs.x) : 0,
    y: parentAbs ? round(abs.y - parentAbs.y) : 0,
    width: round(abs.width || 1),
    height: round(abs.height || 1)
  }

  const isReusableInstance = node.type === 'INSTANCE' && node.componentId && componentMap.has(node.componentId) && node.id !== options.skipComponentForNodeId
  const reusable = isReusableInstance ? componentMap.get(node.componentId) : null
  const renderableChildren = visibleRenderableChildren(node)
  const kind = reusable ? 'component' : inferKind(node, renderableChildren)

  const ir = {
    id: xibId(node.id || cryptoSafeId()),
    figmaId: node.id || '',
    name: node.name || kind,
    type: node.type,
    kind,
    className: reusable?.className || null,
    outlet: sanitizeOutletName(node.name || `${kind}_${shortId(node.id)}`),
    frame,
    arranged: isArranged(node, parentNode),
    sizing: sizingOf(node, parentNode),
    priorities: {},
    constraints: [],
    stack: null,
    text: node.type === 'TEXT' ? String(node.characters || '') : '',
    style: extractStyle(node),
    layout: extractLayout(node),
    meta: {
      hasImageFill: hasImageFill(node),
      preservesChildrenOverImageFill: hasImageFill(node) && renderableChildren.length > 0,
      layoutPositioning: node.layoutPositioning || 'AUTO',
      wraps: node.layoutWrap === 'WRAP'
    },
    children: []
  }

  if (!reusable) {
    ir.children = renderableChildren.map(child => buildIR(child, node, componentMap, options))
    layoutChildren(node, ir, renderableChildren)
  }
  return ir
}

function visibleRenderableChildren(node) {
  return (node.children || []).filter(child => child.visible !== false && isRenderable(child))
}

function isRenderable(node) {
  return node.type === 'TEXT' || VIEW_TYPES.has(node.type)
}

function inferKind(node, renderableChildren = visibleRenderableChildren(node)) {
  if (node.type === 'TEXT') return 'label'
  if (hasImageFill(node) && renderableChildren.length === 0) return 'image'
  return 'view'
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
    counterAxisAlignItems: node.counterAxisAlignItems || 'MIN'
  }
}

function hasImageFill(node) {
  return (node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE')
}

function bounds(node) {
  return node.absoluteBoundingBox || node.absoluteRenderBounds || fallbackBounds(node)
}

function fallbackBounds(node) {
  const box = node.size || {}
  return { x: 0, y: 0, width: box.x || 1, height: box.y || 1 }
}

function extractStyle(node) {
  const fill = firstVisibleSolidPaint(node.fills || [])
  const stroke = firstVisibleSolidPaint(node.strokes || [])
  const effect = (node.effects || []).find(item => item?.visible !== false && item?.type === 'DROP_SHADOW')
  const textStyle = node.style || {}
  const radius = Number.isFinite(node.cornerRadius)
    ? node.cornerRadius
    : Array.isArray(node.rectangleCornerRadii) ? Math.max(...node.rectangleCornerRadii) : 0

  return {
    background: paintToRgba(fill),
    textColor: node.type === 'TEXT' ? paintToRgba(fill) || 'rgba(0, 0, 0, 1)' : null,
    borderColor: paintToRgba(stroke),
    borderWidth: round(node.strokeWeight || 0),
    radius: round(radius || 0),
    opacity: node.opacity == null ? 1 : node.opacity,
    fontSize: round(textStyle.fontSize || 14),
    fontFamily: textStyle.fontFamily || 'System',
    fontWeight: normalizeFontWeight(textStyle.fontWeight || 400),
    lineHeight: round(textStyle.lineHeightPx || 0),
    letterSpacing: round(textStyle.letterSpacing || 0),
    textAlign: String(textStyle.textAlignHorizontal || 'LEFT').toLowerCase(),
    numberOfLines: textStyle.textAutoResize === 'HEIGHT' || textStyle.textAutoResize === 'WIDTH_AND_HEIGHT' ? 0 : 1,
    shadow: effect ? {
      x: round(effect.offset?.x || 0), y: round(effect.offset?.y || 0),
      blur: round(effect.radius || 0), spread: round(effect.spread || 0),
      color: paintColorToRgba(effect.color)
    } : null
  }
}

function isAutoLayout(node) {
  return node?.layoutMode === 'HORIZONTAL' || node?.layoutMode === 'VERTICAL'
}

function isArranged(node, parent) {
  return isAutoLayout(parent) && node.layoutPositioning !== 'ABSOLUTE'
}

// Trả về FIXED | HUG | FILL cho từng trục. Thiếu dữ liệu thì coi là FIXED:
// constraint hằng số an toàn hơn hug (hug thiếu nội dung sẽ co về 0).
function sizingOf(node, parent) {
  return {
    h: node.layoutSizingHorizontal || legacySizing(node, parent, 'HORIZONTAL'),
    v: node.layoutSizingVertical || legacySizing(node, parent, 'VERTICAL')
  }
}

function legacySizing(node, parent, axisMode) {
  if (isArranged(node, parent)) {
    if (parent.layoutMode === axisMode && node.layoutGrow === 1) return 'FILL'
    if (parent.layoutMode !== axisMode && node.layoutAlign === 'STRETCH') return 'FILL'
  }
  if (node.type === 'TEXT') {
    const resize = node.style?.textAutoResize
    if (resize === 'WIDTH_AND_HEIGHT') return 'HUG'
    if (resize === 'HEIGHT' && axisMode === 'VERTICAL') return 'HUG'
    return 'FIXED'
  }
  if (!isAutoLayout(node)) return 'FIXED'
  const mode = node.layoutMode === axisMode ? node.primaryAxisSizingMode : node.counterAxisSizingMode
  return mode === 'AUTO' ? 'HUG' : 'FIXED'
}

function layoutChildren(node, ir, rawChildren) {
  const arranged = ir.children.filter(child => child.arranged)
  ir.stack = isAutoLayout(node) && arranged.length ? buildStack(node, ir, arranged) : null
  const parentBox = bounds(node)
  ir.children.forEach((child, index) => {
    child.constraints = child.arranged && ir.stack
      ? arrangedConstraints(child, ir.stack, arranged)
      : pinnedConstraints(child, rawChildren[index], parentBox)
  })
}

// Figma Auto Layout → UIStackView nằm trong container view.
// Container giữ style (background/radius/border) vì UIStackView trước iOS 14 không render background.
function buildStack(node, ir, arranged) {
  const horizontal = node.layoutMode === 'HORIZONTAL'
  const main = horizontal ? 'h' : 'v'
  const cross = horizontal ? 'v' : 'h'
  const [start, end, center] = horizontal ? ['leading', 'trailing', 'centerX'] : ['top', 'bottom', 'centerY']
  const [crossStart, crossEnd] = horizontal ? ['top', 'bottom'] : ['leading', 'trailing']
  const pad = { leading: node.paddingLeft || 0, trailing: node.paddingRight || 0, top: node.paddingTop || 0, bottom: node.paddingBottom || 0 }
  const primary = node.primaryAxisAlignItems || 'MIN'
  const spaceBetween = primary === 'SPACE_BETWEEN'
  const alignment = arranged.every(child => child.sizing[cross] === 'FILL') ? 'fill' : stackAlignment(node.counterAxisAlignItems, horizontal)

  const pins = [
    { axis: cross, type: crossStart, constant: round(pad[crossStart]) },
    { axis: cross, type: crossEnd, constant: round(pad[crossEnd]) }
  ]
  const pinsBothEnds = spaceBetween || ir.sizing[main] === 'HUG' || arranged.some(child => child.sizing[main] === 'FILL')
  // Chỉ pin cứng cả hai đầu khi nội dung thực sự lấp đầy; còn lại dùng ">=" để container fixed không xung đột.
  if (pinsBothEnds) pins.push({ axis: main, type: start, constant: round(pad[start]) }, { axis: main, type: end, constant: round(pad[end]) })
  else if (primary === 'MAX') pins.push({ axis: main, type: end, constant: round(pad[end]) }, { axis: main, type: start, constant: round(pad[start]), atLeast: true })
  else if (primary === 'CENTER') pins.push({ axis: main, type: center, constant: round((pad[start] - pad[end]) / 2) }, { axis: main, type: start, constant: round(pad[start]), atLeast: true })
  else pins.push({ axis: main, type: start, constant: round(pad[start]) }, { axis: main, type: end, constant: round(pad[end]), atLeast: true })

  return {
    id: xibId(`${node.id || ir.id}#stack`),
    axis: horizontal ? 'horizontal' : 'vertical',
    spacing: spaceBetween ? 0 : round(node.itemSpacing || 0),
    alignment,
    distribution: spaceBetween ? 'equalSpacing' : 'fill',
    frame: {
      x: round(pad.leading),
      y: round(pad.top),
      width: round(Math.max(0, ir.frame.width - pad.leading - pad.trailing)),
      height: round(Math.max(0, ir.frame.height - pad.top - pad.bottom))
    },
    pins
  }
}

function stackAlignment(counter, horizontal) {
  if (counter === 'CENTER') return 'center'
  if (counter === 'MAX') return horizontal ? 'bottom' : 'trailing'
  if (counter === 'BASELINE' && horizontal) return 'firstBaseline'
  return horizontal ? 'top' : 'leading'
}

function arrangedConstraints(child, stack, arranged) {
  const main = stack.axis === 'horizontal' ? 'h' : 'v'
  const result = []
  for (const axis of ['h', 'v']) {
    const dimension = axis === 'h' ? 'width' : 'height'
    const sizing = child.sizing[axis]
    // Label không bao giờ fix size: để intrinsic content size co giãn theo localization.
    if (sizing === 'FIXED' && child.kind !== 'label') result.push({ axis, type: dimension, constant: child.frame[dimension] })
    if (sizing !== 'FILL') continue
    if (axis !== main) {
      if (stack.alignment !== 'fill') result.push({ axis, type: dimension, target: 'stack', constant: 0 })
      continue
    }
    child.priorities[`hugging${axis.toUpperCase()}`] = 249
    const firstFill = arranged.find(item => item.sizing[main] === 'FILL')
    if (firstFill !== child) result.push({ axis, type: dimension, targetFigmaId: firstFill.figmaId, constant: 0 })
  }
  // Nhiều label trong stack ngang: hạ compression của label sau để Xcode không báo content priority ambiguity.
  const labels = arranged.filter(item => item.kind === 'label')
  if (main === 'h' && child.kind === 'label' && labels.indexOf(child) > 0) child.priorities.compressionH = 749
  return result
}

function pinnedConstraints(child, raw, parentBox) {
  const { frame } = child
  const isLabel = child.kind === 'label'
  const figma = raw?.constraints || {}
  const right = round(Math.max(0, parentBox.width - frame.x - frame.width))
  const bottom = round(Math.max(0, parentBox.height - frame.y - frame.height))
  return [
    ...axisPins('h', figma.horizontal || inferHorizontal(frame, parentBox.width, right), {
      start: frame.x, end: right, center: round(frame.x + frame.width / 2 - parentBox.width / 2), size: frame.width
    }, !isLabel && child.sizing.h !== 'HUG', isLabel),
    ...axisPins('v', figma.vertical || inferVertical(frame, parentBox.height, bottom), {
      start: frame.y, end: bottom, center: round(frame.y + frame.height / 2 - parentBox.height / 2), size: frame.height
    }, !isLabel && child.sizing.v !== 'HUG', false)
  ]
}

function axisPins(axis, rule, values, keepSize, stretchFromStart) {
  const [start, end, center, dimension] = axis === 'h' ? ['leading', 'trailing', 'centerX', 'width'] : ['top', 'bottom', 'centerY', 'height']
  const pin = (type, constant, atLeast = false) => atLeast ? { axis, type, constant, atLeast } : { axis, type, constant }
  const sizeOr = fallback => keepSize ? pin(dimension, values.size) : fallback
  const isStretch = rule === 'LEFT_RIGHT' || rule === 'TOP_BOTTOM' || rule === 'SCALE'
  // Label pin LEFT giữ nguyên bề rộng thiết kế bằng leading+trailing thay vì width cố định.
  if (isStretch || (stretchFromStart && (rule === 'LEFT' || rule === 'TOP'))) return [pin(start, values.start), pin(end, values.end)]
  if (rule === 'RIGHT' || rule === 'BOTTOM') return [pin(end, values.end), sizeOr(pin(start, values.start, true))]
  if (rule === 'CENTER') return [pin(center, values.center), sizeOr(pin(start, values.start, true))]
  return [pin(start, values.start), sizeOr(pin(end, values.end, true))]
}

function inferHorizontal(frame, parentWidth, right) {
  const fillsWidth = Math.abs((frame.x + frame.width + right) - parentWidth) < 1 && frame.width / Math.max(parentWidth, 1) > 0.72
  if (fillsWidth && frame.x > 0 && right > 0) return 'LEFT_RIGHT'
  if (Math.abs(frame.x + frame.width / 2 - parentWidth / 2) < 1) return 'CENTER'
  return 'LEFT'
}

function inferVertical(frame, parentHeight, bottom) {
  const fillsHeight = Math.abs((frame.y + frame.height + bottom) - parentHeight) < 1 && frame.height / Math.max(parentHeight, 1) > 0.72
  if (fillsHeight && frame.y > 0 && bottom > 0) return 'TOP_BOTTOM'
  if (Math.abs(frame.y + frame.height / 2 - parentHeight / 2) < 1) return 'CENTER'
  return 'TOP'
}

function generateSwift(className, root, colorRegistry) {
  const descendants = flatten(root).slice(1)
  const outletLines = descendants.map(node => `    @IBOutlet private weak var ${node.outlet}: ${swiftType(node)}!`).join('\n')
  // ponytail: không bỏ background/text/textColor/numberOfLines dù XIB đã có — Web Preview's live-edit
  // (src/preview.js applySwiftPreview) parse các dòng này trực tiếp từ Swift, xoá đi sẽ hỏng tính năng.
  const styleLines = generateSwiftStyleLines(root, { includeStatic: true, rootRef: 'contentView', colorRegistry })
  return `import UIKit\n\nfinal class ${className}: UIView {\n    @IBOutlet private var contentView: UIView!${outletLines ? `\n${outletLines}` : ''}\n\n    override init(frame: CGRect) {\n        super.init(frame: frame)\n        commonInit()\n    }\n\n    required init?(coder: NSCoder) {\n        super.init(coder: coder)\n        commonInit()\n    }\n\n    private func commonInit() {\n        Bundle(for: Self.self).loadNibNamed(String(describing: Self.self), owner: self, options: nil)\n        guard let contentView else { return }\n        addSubview(contentView)\n        contentView.translatesAutoresizingMaskIntoConstraints = false\n        NSLayoutConstraint.activate([\n            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),\n            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),\n            contentView.topAnchor.constraint(equalTo: topAnchor),\n            contentView.bottomAnchor.constraint(equalTo: bottomAnchor)\n        ])\n        applyGeneratedStyle()\n    }\n\n    /// UIKitForge watches common UIKit assignments in this method and mirrors them in Web Preview.\n    /// Native validation remains the final source of truth once the macOS agent is connected.\n    private func applyGeneratedStyle() {\n${styleLines || '        // No runtime-only styles were required for this node.'}\n    }\n}\n`
}

// includeStatic: bật khi không có XIB đi kèm (biến thể programmatic) — lúc đó Swift là nguồn duy nhất cho
// background/text/textColor/numberOfLines/textAlignment/contentMode; XIB variant giữ false để tránh set trùng.
function generateSwiftStyleLines(root, { includeStatic = false, rootRef = 'contentView', colorRegistry } = {}) {
  const lines = []
  for (const [index, node] of flatten(root).entries()) {
    const targetRef = index === 0 ? rootRef : node.outlet
    const target = targetRef === 'self' ? '' : `${targetRef}.` // self ngầm định — tránh redundantSelf của SwiftFormat
    const hint = node.outlet || 'root'
    const style = node.style || {}
    if (includeStatic && style.background) lines.push(`        ${target}backgroundColor = ${namedColor(colorRegistry, style.background, `${hint}Background`)}`)
    if (style.radius > 0) {
      lines.push(`        ${target}layer.cornerRadius = ${formatNumber(style.radius)}`)
      lines.push(`        ${target}layer.masksToBounds = true`)
    }
    if (style.borderColor && style.borderWidth > 0) {
      lines.push(`        ${target}layer.borderColor = ${namedColor(colorRegistry, style.borderColor, `${hint}Border`)}.cgColor`)
      lines.push(`        ${target}layer.borderWidth = ${formatNumber(style.borderWidth)}`)
    }
    if (style.opacity < 1) lines.push(`        ${target}alpha = ${formatNumber(style.opacity)}`)
    if (node.kind === 'label') {
      if (includeStatic) {
        lines.push(`        ${target}text = ${swiftString(node.text)}`)
        if (style.textColor) lines.push(`        ${target}textColor = ${namedColor(colorRegistry, style.textColor, `${hint}Text`)}`)
        lines.push(`        ${target}numberOfLines = ${style.numberOfLines}`)
        if (style.textAlign !== 'left') lines.push(`        ${target}textAlignment = .${swiftTextAlignment(style.textAlign)}`)
      }
      lines.push(`        ${target}font = ${swiftFontExpression(style)}`)
      // adjustsFontForContentSizeCategory: UIFont.systemFont không tự scale theo Dynamic Type như SwiftUI's
      // .system(size:) — phải bật cờ này + UIFontMetrics ở trên thì UILabel mới tôn trọng cỡ chữ hệ thống.
      lines.push(`        ${target}adjustsFontForContentSizeCategory = true`)
    }
    if (node.kind === 'image' && includeStatic) {
      lines.push(`        ${target}contentMode = .scaleAspectFit`)
      // Tên asset = outlet, khớp với Image(...) bên SwiftUI — xem generateUIKitAssets ở figma.js/main.js.
      lines.push(`        ${target}image = UIImage(named: ${swiftString(node.outlet)})`)
      // VoiceOver: layer Figma không phân biệt ảnh trang trí và ảnh nội dung, nên coi mọi UIImageView là
      // nội dung có nghĩa và gán accessibilityLabel từ tên layer; tên vô nghĩa (Rectangle 12, Frame 3...)
      // vẫn còn hơn im lặng hoàn toàn với VoiceOver.
      lines.push(`        ${target}isAccessibilityElement = true`)
      lines.push(`        ${target}accessibilityLabel = ${swiftString(humanizeLayerName(node.name))}`)
    }
    if (style.shadow) {
      lines.push(`        ${target}layer.shadowColor = ${namedColor(colorRegistry, style.shadow.color || 'rgba(0, 0, 0, 0.2)', `${hint}Shadow`)}.cgColor`)
      lines.push(`        ${target}layer.shadowOpacity = ${formatNumber(alphaFromRgba(style.shadow.color || 'rgba(0,0,0,0.2)'))}`)
      lines.push(`        ${target}layer.shadowOffset = CGSize(width: ${formatNumber(style.shadow.x)}, height: ${formatNumber(style.shadow.y)})`)
      lines.push(`        ${target}layer.shadowRadius = ${formatNumber(style.shadow.blur / 2)}`)
      lines.push(`        ${target}layer.masksToBounds = false`)
    }
  }
  return lines.join('\n')
}

function swiftFontExpression(style) {
  const weight = swiftFontWeight(style.fontWeight)
  const base = style.fontFamily && style.fontFamily !== 'System'
    ? `UIFont(name: ${swiftString(style.fontFamily)}, size: ${formatNumber(style.fontSize)}) ?? .systemFont(ofSize: ${formatNumber(style.fontSize)}, weight: .${weight})`
    : `UIFont.systemFont(ofSize: ${formatNumber(style.fontSize)}, weight: .${weight})`
  // UIFontMetrics giữ đúng size Figma ở cỡ chữ mặc định nhưng vẫn scale theo Dynamic Type,
  // thay vì .systemFont cố định — xem ghi chú adjustsFontForContentSizeCategory ở nơi gọi.
  return `UIFontMetrics(forTextStyle: .${nearestTextStyle(style.fontSize, style.fontWeight)}).scaledFont(for: ${base})`
}

// Khớp fontSize Figma với UIFont.TextStyle gần nhất để UIFontMetrics scale đúng đường cong Dynamic Type của Apple.
function nearestTextStyle(fontSize, fontWeight) {
  const sizes = [
    ['largeTitle', 34], ['title1', 28], ['title2', 22], ['title3', 20],
    ['body', 17], ['callout', 16], ['subheadline', 15],
    ['footnote', 13], ['caption1', 12], ['caption2', 11]
  ]
  let best = sizes[sizes.length - 1]
  let bestDiff = Infinity
  for (const entry of sizes) {
    const diff = Math.abs(entry[1] - (fontSize || 14))
    if (diff < bestDiff) { bestDiff = diff; best = entry }
  }
  if (best[0] === 'body' && (fontWeight || 400) >= 600) return 'headline'
  return best[0]
}

// Tên layer Figma ("Rectangle 12", "hero_image") không phải câu văn đọc được — tách theo case/dấu gạch
// dưới thành từ rồi viết hoa chữ đầu để VoiceOver đọc tự nhiên hơn một chút so với đọc nguyên tên kỹ thuật.
function humanizeLayerName(value) {
  const words = String(value || 'Image')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || 'Image'
}

function swiftTextAlignment(value) { if (value === 'center') return 'center'; if (value === 'right') return 'right'; if (value === 'justified') return 'justified'; return 'natural' }

// Sinh view hoàn toàn bằng code (không XIB): cùng IR, cùng constraint format với generateXib,
// chỉ đổi cách emit sang NSLayoutConstraint anchor. Dùng khi user chọn output UIKit-Code.
export function generateSwiftProgrammatic(className, root, colorRegistry) {
  const descendants = flatten(root).slice(1)
  const refs = new Map([[root.id, 'self']])
  const figmaRefs = new Map([[root.figmaId, 'self']])
  const propertyLines = []
  if (root.stack) { refs.set(root.stack.id, 'rootStack'); propertyLines.push('    private let rootStack = UIStackView()') }
  for (const node of descendants) {
    refs.set(node.id, node.outlet)
    figmaRefs.set(node.figmaId, node.outlet)
    propertyLines.push(`    private let ${node.outlet} = ${swiftType(node)}()`)
    if (node.stack) {
      const stackRef = `${node.outlet}Stack`
      refs.set(node.stack.id, stackRef)
      propertyLines.push(`    private let ${stackRef} = UIStackView()`)
    }
  }
  // Tách building của từng con trực tiếp của root thành method riêng để commonInit() không vượt
  // SwiftLint function_body_length; tầng lồng sâu hơn vẫn build đệ quy trong method của con đó.
  // ponytail: chỉ tách 1 cấp — một nhánh con cực sâu/rộng vẫn có thể vượt 50 dòng, tách thêm khi gặp trường hợp đó.
  const initLines = []
  const methods = []
  const pinned = root.stack ? root.children.filter(child => !child.arranged) : root.children
  if (root.stack) {
    const stackRef = refs.get(root.stack.id)
    const arranged = root.children.filter(child => child.arranged)
    initLines.push(...swiftStackSetupLines(root.stack, stackRef))
    for (const child of arranged) initLines.push(`        ${stackRef}.addArrangedSubview(${refs.get(child.id)})`)
    for (const child of arranged) initLines.push(...swiftConstraintLines(stackRef, refs.get(child.id), child.constraints, refs, figmaRefs))
    for (const child of arranged) pushProgrammaticChildMethod(child, refs.get(child.id), refs, figmaRefs, methods, initLines)
    initLines.push(`        addSubview(${stackRef})`)
    initLines.push(`        ${stackRef}.translatesAutoresizingMaskIntoConstraints = false`)
    initLines.push(...swiftConstraintLines('self', stackRef, root.stack.pins, refs, figmaRefs))
  }
  for (const child of pinned) initLines.push(`        addSubview(${refs.get(child.id)})`)
  for (const child of pinned) initLines.push(`        ${refs.get(child.id)}.translatesAutoresizingMaskIntoConstraints = false`)
  for (const child of pinned) initLines.push(...swiftConstraintLines('self', refs.get(child.id), child.constraints, refs, figmaRefs))
  for (const child of pinned) pushProgrammaticChildMethod(child, refs.get(child.id), refs, figmaRefs, methods, initLines)

  const styleLines = generateSwiftStyleLines(root, { includeStatic: true, rootRef: 'self', colorRegistry })
  const methodBlocks = methods.map(m => `\n    private func ${m.name}() {\n${m.lines.join('\n')}\n    }\n`).join('')
  return `import UIKit\n\nfinal class ${className}: UIView {\n${propertyLines.join('\n')}\n\n    override init(frame: CGRect) {\n        super.init(frame: frame)\n        commonInit()\n    }\n\n    required init?(coder: NSCoder) {\n        super.init(coder: coder)\n        commonInit()\n    }\n\n    private func commonInit() {\n${initLines.join('\n')}\n        applyGeneratedStyle()\n    }\n${methodBlocks}\n    private func applyGeneratedStyle() {\n${styleLines || '        // No runtime-only styles were required for this node.'}\n    }\n}\n`
}

function pushProgrammaticChildMethod(child, childRef, refs, figmaRefs, methods, callerLines) {
  if (!child.children || !child.children.length) return
  const methodLines = []
  emitProgrammaticContainer(child, childRef, refs, figmaRefs, methodLines)
  if (!methodLines.length) return
  const name = `configure${child.outlet.charAt(0).toUpperCase()}${child.outlet.slice(1)}`
  methods.push({ name, lines: methodLines })
  callerLines.push(`        ${name}()`)
}

// Hai lượt (thêm subview rồi mới activate constraint) để constraint chéo-anh-em trong cùng stack
// luôn thấy view kia đã có ancestor chung trước khi kích hoạt.
function emitProgrammaticContainer(node, parentRef, refs, figmaRefs, lines) {
  const pinned = node.stack ? node.children.filter(child => !child.arranged) : node.children
  if (node.stack) {
    const stackRef = refs.get(node.stack.id)
    const arranged = node.children.filter(child => child.arranged)
    lines.push(...swiftStackSetupLines(node.stack, stackRef))
    for (const child of arranged) lines.push(`        ${stackRef}.addArrangedSubview(${refs.get(child.id)})`)
    for (const child of arranged) lines.push(...swiftConstraintLines(stackRef, refs.get(child.id), child.constraints, refs, figmaRefs))
    for (const child of arranged) emitProgrammaticContainer(child, refs.get(child.id), refs, figmaRefs, lines)
    lines.push(`        ${parentRef}.addSubview(${stackRef})`)
    lines.push(`        ${stackRef}.translatesAutoresizingMaskIntoConstraints = false`)
    lines.push(...swiftConstraintLines(parentRef, stackRef, node.stack.pins, refs, figmaRefs))
  }
  for (const child of pinned) lines.push(`        ${parentRef}.addSubview(${refs.get(child.id)})`)
  for (const child of pinned) lines.push(`        ${refs.get(child.id)}.translatesAutoresizingMaskIntoConstraints = false`)
  for (const child of pinned) lines.push(...swiftConstraintLines(parentRef, refs.get(child.id), child.constraints, refs, figmaRefs))
  for (const child of pinned) emitProgrammaticContainer(child, refs.get(child.id), refs, figmaRefs, lines)
}

function swiftStackSetupLines(stack, ref) {
  const lines = []
  if (stack.axis === 'vertical') lines.push(`        ${ref}.axis = .vertical`)
  if (stack.distribution === 'equalSpacing') lines.push(`        ${ref}.distribution = .equalSpacing`)
  if (stack.alignment !== 'fill') {
    const alignment = { top: '.top', center: '.center', bottom: '.bottom', firstBaseline: '.firstBaseline', leading: '.leading', trailing: '.trailing' }[stack.alignment] || '.fill'
    lines.push(`        ${ref}.alignment = ${alignment}`)
  }
  if (stack.spacing) lines.push(`        ${ref}.spacing = ${formatNumber(stack.spacing)}`)
  return lines
}

// Cùng quy ước dấu/first-second với constraintXml (xem comment tại đó) để hai output khớp nhau tuyệt đối.
function swiftConstraintLines(parentRef, childRef, constraints, refs, figmaRefs) {
  return (constraints || []).flatMap(constraint => swiftConstraintLine(parentRef, childRef, constraint, refs, figmaRefs)).filter(Boolean)
}

const SWIFT_ANCHOR = { leading: 'leadingAnchor', trailing: 'trailingAnchor', top: 'topAnchor', bottom: 'bottomAnchor', centerX: 'centerXAnchor', centerY: 'centerYAnchor' }

// Không viết "self." thừa (SwiftFormat mặc định loại bỏ) — self chỉ ngầm định khi ref là view hiện tại.
function swiftAnchor(ref, anchor) { return ref === 'self' ? anchor : `${ref}.${anchor}` }

function swiftConstraintLine(parentRef, childRef, constraint, refs, figmaRefs) {
  const { type, constant, atLeast, target, targetFigmaId } = constraint
  const relation = atLeast ? 'greaterThanOrEqualTo' : 'equalTo'
  if (type === 'width' || type === 'height') {
    const anchor = `${type}Anchor`
    if (target === 'stack') return [`        ${swiftAnchor(childRef, anchor)}.constraint(${relation}: ${swiftAnchor(parentRef, anchor)}).isActive = true`]
    if (targetFigmaId) {
      const otherRef = figmaRefs.get(targetFigmaId)
      return otherRef ? [`        ${swiftAnchor(childRef, anchor)}.constraint(${relation}: ${swiftAnchor(otherRef, anchor)}).isActive = true`] : []
    }
    return [`        ${swiftAnchor(childRef, anchor)}.constraint(equalToConstant: ${formatNumber(constant)}).isActive = true`]
  }
  const anchor = SWIFT_ANCHOR[type]
  const [firstRef, secondRef] = type === 'trailing' || type === 'bottom' ? [parentRef, childRef] : [childRef, parentRef]
  const constantPart = constant ? `, constant: ${formatNumber(constant)}` : ''
  return [`        ${swiftAnchor(firstRef, anchor)}.constraint(${relation}: ${swiftAnchor(secondRef, anchor)}${constantPart}).isActive = true`]
}

function generateXib(className, root, deploymentTarget = MIN_DEPLOYMENT_TARGET) {
  const ctx = { used: new Set(flatten(root).flatMap(node => node.stack ? [node.id, node.stack.id] : [node.id])) }
  const descendants = flatten(root).slice(1)
  const outlets = [
    `                <outlet property="contentView" destination="${root.id}" id="${generatedId(ctx, `out|${root.id}`)}"/>`,
    ...descendants.map(node => `                <outlet property="${xmlEscape(node.outlet)}" destination="${node.id}" id="${generatedId(ctx, `out|${node.id}`)}"/>`)
  ].join('\n')
  // XIB mã hoá deployment target dạng major << 8 (iOS 13 → 3328).
  return `<?xml version="1.0" encoding="UTF-8"?>\n<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB" version="3.0" toolsVersion="23504" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" colorMatched="YES">\n    <device id="retina6_12" orientation="portrait" appearance="light"/>\n    <dependencies>\n        <deployment version="${deploymentTarget * 256}" identifier="iOS"/>\n        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="23506"/>\n    </dependencies>\n    <objects>\n        <placeholder placeholderIdentifier="IBFilesOwner" id="-1" userLabel="File's Owner" customClass="${xmlEscape(className)}" customModuleProvider="target">\n            <connections>\n${outlets}\n            </connections>\n        </placeholder>\n        <placeholder placeholderIdentifier="IBFirstResponder" id="-2" customClass="UIResponder"/>\n${viewXml(root, true, 2, ctx)}\n    </objects>\n</document>\n`
}

function viewXml(node, isRoot, level, ctx, offset = null) {
  if (node.kind === 'label') return labelXml(node, level, isRoot, offset)
  if (node.kind === 'image') return imageXml(node, level, isRoot, offset)

  const indent = '    '.repeat(level)
  const attrs = ['contentMode="scaleToFill"', ...priorityAttrs(node), 'translatesAutoresizingMaskIntoConstraints="NO"', `id="${node.id}"`, `userLabel="${xmlEscape(node.name)}"`]
  if (node.kind === 'component' && node.className) attrs.push(`customClass="${xmlEscape(node.className)}"`, 'customModuleProvider="target"')
  const stack = node.stack
  const pinned = stack ? node.children.filter(child => !child.arranged) : node.children
  const childXml = [
    stack ? stackXml(node, level + 2, ctx) : '',
    ...pinned.map(child => viewXml(child, false, level + 2, ctx))
  ].filter(Boolean).join('\n')
  const constraints = [
    ...(stack ? stack.pins.map(pin => constraintXml(node.id, stack.id, pin, null, level + 2, ctx)) : []),
    ...childConstraintRows(node.id, pinned, node.children, level + 2, ctx)
  ].join('\n')
  const bg = colorXml('backgroundColor', node.style.background, level + 1)
  const subviewsBlock = childXml ? `${indent}    <subviews>\n${childXml}\n${indent}    </subviews>\n` : ''
  const constraintsBlock = constraints ? `${indent}    <constraints>\n${constraints}\n${indent}    </constraints>\n` : ''
  return `${indent}<view ${attrs.join(' ')}>\n${rectXml(node.frame, isRoot, indent, offset)}${subviewsBlock}${bg}${constraintsBlock}${indent}</view>`
}

function stackXml(node, level, ctx) {
  const indent = '    '.repeat(level)
  const { stack } = node
  const arranged = node.children.filter(child => child.arranged)
  // Chỉ ghi thuộc tính khác mặc định (horizontal/fill/0) giống cách Interface Builder serialize.
  const attrs = [
    'opaque="NO"', 'contentMode="scaleToFill"',
    stack.axis === 'vertical' ? 'axis="vertical"' : '',
    stack.distribution !== 'fill' ? `distribution="${stack.distribution}"` : '',
    stack.alignment !== 'fill' ? `alignment="${stack.alignment}"` : '',
    stack.spacing ? `spacing="${formatNumber(stack.spacing)}"` : '',
    'translatesAutoresizingMaskIntoConstraints="NO"', `id="${stack.id}"`, `userLabel="${xmlEscape(`${node.name} Stack`)}"`
  ].filter(Boolean)
  const childOffset = { x: stack.frame.x, y: stack.frame.y }
  const childXml = arranged.map(child => viewXml(child, false, level + 2, ctx, childOffset)).join('\n')
  const constraints = childConstraintRows(stack.id, arranged, node.children, level + 2, ctx).join('\n')
  const constraintsBlock = constraints ? `${indent}    <constraints>\n${constraints}\n${indent}    </constraints>\n` : ''
  return `${indent}<stackView ${attrs.join(' ')}>\n${rectXml(stack.frame, false, indent)}${indent}    <subviews>\n${childXml}\n${indent}    </subviews>\n${constraintsBlock}${indent}</stackView>`
}

function labelXml(node, level, isRoot = false, offset = null) {
  const indent = '    '.repeat(level)
  const style = node.style
  const fontType = style.fontWeight >= 600 ? 'boldSystem' : 'system'
  const bg = colorXml('backgroundColor', style.background, level + 1)
  const textColor = colorXml('textColor', style.textColor || 'rgba(0, 0, 0, 1)', level + 1)
  const attrs = ['opaque="NO"', 'userInteractionEnabled="NO"', 'contentMode="left"', ...priorityAttrs(node, 251), `text="${xmlEscape(node.text)}"`, `textAlignment="${xibTextAlignment(style.textAlign)}"`, 'lineBreakMode="tailTruncation"', `numberOfLines="${style.numberOfLines}"`, 'baselineAdjustment="alignBaselines"', 'adjustsFontSizeToFit="NO"', 'translatesAutoresizingMaskIntoConstraints="NO"', `id="${node.id}"`, `userLabel="${xmlEscape(node.name)}"`]
  return `${indent}<label ${attrs.join(' ')}>\n${rectXml(node.frame, isRoot, indent, offset)}${indent}    <fontDescription key="fontDescription" type="${fontType}" pointSize="${formatNumber(style.fontSize)}"/>\n${textColor}${bg}${indent}    <nil key="highlightedColor"/>\n${indent}</label>`
}

function imageXml(node, level, isRoot = false, offset = null) {
  const indent = '    '.repeat(level)
  const bg = colorXml('backgroundColor', node.style.background, level + 1)
  const attrs = ['clipsSubviews="YES"', 'userInteractionEnabled="NO"', 'contentMode="scaleAspectFit"', ...priorityAttrs(node), 'translatesAutoresizingMaskIntoConstraints="NO"', `id="${node.id}"`, `userLabel="${xmlEscape(node.name)}"`]
  return `${indent}<imageView ${attrs.join(' ')}>\n${rectXml(node.frame, isRoot, indent, offset)}${bg}${indent}</imageView>`
}

function colorXml(key, rgba, level) {
  if (!rgba) return ''
  const color = parseRgba(rgba)
  if (!color) return ''
  const indent = '    '.repeat(level)
  return `${indent}<color key="${key}" red="${unit(color.r)}" green="${unit(color.g)}" blue="${unit(color.b)}" alpha="${unit(color.a)}" colorSpace="custom" customColorSpace="sRGB"/>\n`
}

function rectXml(frame, isRoot, indent, offset = null) {
  const x = isRoot ? 0 : frame.x - (offset?.x || 0)
  const y = isRoot ? 0 : frame.y - (offset?.y || 0)
  return `${indent}    <rect key="frame" x="${formatNumber(x)}" y="${formatNumber(y)}" width="${formatNumber(frame.width)}" height="${formatNumber(frame.height)}"/>\n`
}

function priorityAttrs(node, defaultHugging = null) {
  const p = node.priorities || {}
  const hugH = p.huggingH ?? defaultHugging
  const hugV = p.huggingV ?? defaultHugging
  return [
    hugH != null ? `horizontalHuggingPriority="${hugH}"` : '',
    hugV != null ? `verticalHuggingPriority="${hugV}"` : '',
    p.compressionH != null ? `horizontalCompressionResistancePriority="${p.compressionH}"` : '',
    p.compressionV != null ? `verticalCompressionResistancePriority="${p.compressionV}"` : ''
  ].filter(Boolean)
}

function childConstraintRows(parentId, children, siblings, level, ctx) {
  const byFigmaId = new Map(siblings.map(child => [child.figmaId, child]))
  return children.flatMap(child => (child.constraints || []).map(constraint => {
    const target = constraint.targetFigmaId ? byFigmaId.get(constraint.targetFigmaId) : null
    return constraintXml(parentId, child.id, constraint, target, level, ctx)
  })).filter(Boolean)
}

// Quy ước: constant là khoảng inset dương; atLeast nghĩa là inset >= constant.
// trailing/bottom đặt parent làm firstItem để constant luôn dương như Interface Builder.
function constraintXml(parentId, childId, constraint, target, level, ctx) {
  const indent = '    '.repeat(level)
  const { type } = constraint
  const constant = formatNumber(constraint.constant)
  const relation = constraint.atLeast ? ' relation="greaterThanOrEqual"' : ''
  const id = generatedId(ctx, `c|${parentId}|${childId}|${type}|${constraint.target || constraint.targetFigmaId || ''}`)
  if (type === 'width' || type === 'height') {
    if (constraint.target === 'stack') return `${indent}<constraint firstItem="${childId}" firstAttribute="${type}" secondItem="${parentId}" secondAttribute="${type}" id="${id}"/>`
    if (constraint.targetFigmaId) return target ? `${indent}<constraint firstItem="${childId}" firstAttribute="${type}" secondItem="${target.id}" secondAttribute="${type}" id="${id}"/>` : ''
    return `${indent}<constraint firstItem="${childId}" firstAttribute="${type}" constant="${constant}" id="${id}"/>`
  }
  const [first, second] = type === 'trailing' || type === 'bottom' ? [parentId, childId] : [childId, parentId]
  return `${indent}<constraint firstItem="${first}" firstAttribute="${type}"${relation} secondItem="${second}" secondAttribute="${type}" constant="${constant}" id="${id}"/>`
}

function collectLayoutWarnings(root) {
  const warnings = []
  for (const node of flatten(root)) {
    if (node !== root && !node.arranged && !hasTwoAxisConstraints(node.constraints || [])) warnings.push(`${node.name}: UIKitForge could not infer a complete two-axis Auto Layout rule.`)
    if (node.meta?.wraps) warnings.push(`${node.name}: Figma wrap Auto Layout has no UIStackView equivalent; children were laid out in a single line.`)
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') warnings.push(`${node.name}: vector geometry is still represented as a UIView placeholder; SVG/PDF asset export is the next compiler stage.`)
    if (node.kind === 'image') warnings.push(`${node.name}: image fill is represented as UIImageView but the binary asset is not exported yet.`)
    if (node.meta?.preservesChildrenOverImageFill) warnings.push(`${node.name}: Figma uses an image fill on a container. UIKitForge preserved its child hierarchy instead of collapsing the container into UIImageView; the background image asset is not exported yet.`)
    // HIG: vùng chạm tối thiểu 44x44pt. Component instance (INSTANCE trong Figma) thường là nút/control
    // tương tác, nên đây là proxy hợp lý dù compiler chưa model được khái niệm "tappable" tường minh.
    if (node.kind === 'component' && (node.frame?.width < 44 || node.frame?.height < 44)) {
      warnings.push(`${node.name}: component is ${formatNumber(node.frame.width)}x${formatNumber(node.frame.height)}pt, below Apple's 44x44pt minimum tap target. Consider padding the hit area if this is interactive.`)
    }
  }
  return warnings
}

function hasTwoAxisConstraints(constraints) {
  const h = constraints.some(item => item.axis === 'h')
  const v = constraints.some(item => item.axis === 'v')
  return h && v
}

function dedupeOutlets(root) {
  const used = new Map()
  for (const node of flatten(root).slice(1)) {
    const base = node.outlet
    const count = (used.get(base) || 0) + 1
    used.set(base, count)
    if (count > 1) node.outlet = `${base}${count}`
  }
}

function flatten(root) {
  const result = []
  const visit = node => {
    result.push(node)
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return result
}

function swiftType(node) {
  if (node.kind === 'label') return 'UILabel'
  if (node.kind === 'image') return 'UIImageView'
  if (node.kind === 'component' && node.className) return node.className
  return 'UIView'
}

function sanitizeClassName(value, fallback) {
  const parts = String(value || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  let result = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('') || fallback
  if (/^[0-9]/.test(result)) result = `View${result}`
  return result
}

function sanitizeOutletName(value) {
  const parts = String(value || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  let result = parts.map((part, index) => index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'generatedView'
  if (/^[0-9]/.test(result)) result = `view${result}`
  if (SWIFT_KEYWORDS.has(result)) result += 'View'
  if (result.length < 3) result += 'View' // SwiftLint identifier_name requires >= 3 chars (e.g. a layer named "A")
  return result
}

function uniqueClassName(base, used) {
  let candidate = base
  let index = 2
  while (used.has(candidate)) candidate = `${base}${index++}`
  used.add(candidate)
  return candidate
}

const SWIFT_KEYWORDS = new Set(['class', 'struct', 'enum', 'protocol', 'extension', 'func', 'var', 'let', 'self', 'super', 'switch', 'case', 'default', 'if', 'else', 'for', 'while', 'do', 'return', 'import', 'private', 'public', 'internal', 'fileprivate', 'open'])

function paintToRgba(paint) {
  if (!paint?.color) return null
  const { r = 0, g = 0, b = 0, a = 1 } = paint.color
  const alpha = paint.opacity == null ? a : a * paint.opacity
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(alpha.toFixed(3))})`
}

function paintColorToRgba(color) {
  if (!color) return null
  const { r = 0, g = 0, b = 0, a = 1 } = color
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(a.toFixed(3))})`
}

function rgbaToSwift(rgba) {
  const c = parseRgba(rgba) || { r: 0, g: 0, b: 0, a: 1 }
  return `UIColor(red: ${unit(c.r)}, green: ${unit(c.g)}, blue: ${unit(c.b)}, alpha: ${unit(c.a)})`
}

// Tham chiếu Color Asset (Colors.xcassets) thay vì literal UIColor(red:...) để hỗ trợ Dark Mode thật qua Xcode.
// colorRegistry có thể null khi gọi generateSwiftStyleLines ngoài luồng compile chính (ví dụ test lẻ) — fallback
// về literal color để không throw.
function namedColor(colorRegistry, rgba, hint) {
  if (!colorRegistry) return rgbaToSwift(rgba)
  return `UIColor(named: ${swiftString(colorRegistry.register(rgba, hint))})`
}

export function parseRgba(value) {
  const match = String(value || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i)
  if (!match) return null
  return { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255, a: match[4] == null ? 1 : Number(match[4]) }
}

function alphaFromRgba(value) { return parseRgba(value)?.a ?? 1 }
function unit(value) { return Number(Math.max(0, Math.min(1, value)).toFixed(5)) }
function normalizeFontWeight(weight) { const n = Number(weight); return Number.isFinite(n) ? Math.max(100, Math.min(900, n)) : 400 }
export function swiftFontWeight(weight) { if (weight >= 800) return 'heavy'; if (weight >= 700) return 'bold'; if (weight >= 600) return 'semibold'; if (weight >= 500) return 'medium'; if (weight <= 300) return 'light'; return 'regular' }
export function swiftString(value) { return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` }
function xibTextAlignment(value) { if (value === 'center') return 'center'; if (value === 'right') return 'right'; if (value === 'justified') return 'justified'; return 'natural' }
function xmlEscape(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
// ID băm từ Figma node id: ổn định giữa các lần export (diff XIB gọn) và không trùng hậu tố như cách cắt chuỗi cũ.
function xibId(value) { return `UF-${hashId(value || cryptoSafeId())}` }
function hashId(value) { let hash = 0x811c9dc5; for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0 } return hash.toString(36).padStart(7, '0') }
function claimId(ctx, id) { let candidate = id; for (let n = 2; ctx.used.has(candidate); n++) candidate = xibId(`${id}#${n}`); ctx.used.add(candidate); return candidate }
function generatedId(ctx, seed) { return claimId(ctx, xibId(seed)) }
function ensureUniqueIds(root) { const ctx = { used: new Set() }; for (const node of flatten(root)) { node.id = claimId(ctx, node.id); if (node.stack) node.stack.id = claimId(ctx, node.stack.id) } }
function normalizeDeploymentTarget(value) { const major = Math.trunc(Number.parseFloat(value)); return Number.isFinite(major) ? Math.min(MAX_DEPLOYMENT_TARGET, Math.max(MIN_DEPLOYMENT_TARGET, major)) : MIN_DEPLOYMENT_TARGET }
function shortId(value) { return String(value || '').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'node' }
function cryptoSafeId() { return Math.random().toString(36).slice(2, 12) }
function round(value) { return Number(Number(value || 0).toFixed(2)) }
export function formatNumber(value) { return Number(Number(value || 0).toFixed(2)).toString() }
