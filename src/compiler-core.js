import { findComponentCandidates, firstVisibleSolidPaint } from './figma.js'

const VIEW_TYPES = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE',
  'RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'
])

export function compileUIKit(figmaData, requestedRootClass = '') {
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

  const files = []
  const components = []
  for (const [componentId, entry] of componentMap.entries()) {
    const ir = buildIR(entry.source, null, componentMap, { skipComponentForNodeId: entry.source.id })
    dedupeOutlets(ir)
    files.push(
      { path: `Components/${entry.className}/${entry.className}.swift`, name: `${entry.className}.swift`, language: 'swift', content: generateSwift(entry.className, ir), kind: 'component' },
      { path: `Components/${entry.className}/${entry.className}.xib`, name: `${entry.className}.xib`, language: 'xml', content: generateXib(entry.className, ir), kind: 'component' }
    )
    components.push({ componentId, className: entry.className, sourceName: entry.source.name || 'Component' })
  }

  const mainIR = buildIR(sourceRoot, null, componentMap, { skipComponentForNodeId: sourceRoot.id })
  dedupeOutlets(mainIR)
  files.unshift(
    { path: `${rootClass}/${rootClass}.xib`, name: `${rootClass}.xib`, language: 'xml', content: generateXib(rootClass, mainIR), kind: 'main' },
    { path: `${rootClass}/${rootClass}.swift`, name: `${rootClass}.swift`, language: 'swift', content: generateSwift(rootClass, mainIR), kind: 'main' }
  )

  warnings.push(...collectLayoutWarnings(mainIR))
  return { rootClass, sourceRoot, previewRoot: mainIR, files, components, warnings: [...new Set(warnings)] }
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

function buildIR(node, parentNode, componentMap, options = {}, siblingIndex = 0, siblings = []) {
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
    constraints: inferConstraints(node, parentNode, frame, siblingIndex, siblings),
    text: node.type === 'TEXT' ? String(node.characters || '') : '',
    style: extractStyle(node),
    layout: extractLayout(node),
    meta: {
      hasImageFill: hasImageFill(node),
      preservesChildrenOverImageFill: hasImageFill(node) && renderableChildren.length > 0,
      layoutPositioning: node.layoutPositioning || 'AUTO'
    },
    children: []
  }

  if (!reusable) {
    ir.children = renderableChildren.map((child, index) => buildIR(child, node, componentMap, options, index, renderableChildren))
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

function inferConstraints(node, parent, frame, siblingIndex = 0, siblings = []) {
  if (!parent) return []
  if (node.layoutPositioning === 'ABSOLUTE' || !['HORIZONTAL', 'VERTICAL'].includes(parent.layoutMode)) {
    return inferPinnedConstraints(node, parent, frame)
  }
  return inferAutoLayoutConstraints(node, parent, frame, siblingIndex, siblings)
}

function inferAutoLayoutConstraints(node, parent, frame, siblingIndex, siblings) {
  const result = []
  const mode = parent.layoutMode
  const prev = siblingIndex > 0 ? siblings[siblingIndex - 1] : null
  const parentBox = bounds(parent)
  const right = round(Math.max(0, parentBox.width - frame.x - frame.width))
  const bottom = round(Math.max(0, parentBox.height - frame.y - frame.height))
  const centerX = round(frame.x + frame.width / 2 - parentBox.width / 2)
  const centerY = round(frame.y + frame.height / 2 - parentBox.height / 2)

  if (mode === 'HORIZONTAL') {
    if (prev) result.push({ axis: 'h', type: 'leadingToTrailing', targetFigmaId: prev.id, constant: round(parent.itemSpacing || 0) })
    else result.push({ axis: 'h', type: 'leading', constant: round(parent.paddingLeft ?? frame.x) })
    result.push({ axis: 'h', type: 'width', constant: frame.width })
    addCrossAxisConstraints(result, node, parent, 'v', frame, { start: frame.y, end: bottom, center: centerY })
  } else {
    if (prev) result.push({ axis: 'v', type: 'topToBottom', targetFigmaId: prev.id, constant: round(parent.itemSpacing || 0) })
    else result.push({ axis: 'v', type: 'top', constant: round(parent.paddingTop ?? frame.y) })
    result.push({ axis: 'v', type: 'height', constant: frame.height })
    addCrossAxisConstraints(result, node, parent, 'h', frame, { start: frame.x, end: right, center: centerX })
  }
  return result
}

function addCrossAxisConstraints(result, node, parent, axis, frame, values) {
  const explicit = node.layoutAlign
  const parentAlign = parent.counterAxisAlignItems || 'MIN'
  const stretch = explicit === 'STRETCH' || parentAlign === 'STRETCH'
  const center = explicit === 'INHERIT' ? parentAlign === 'CENTER' : explicit === 'CENTER' || parentAlign === 'CENTER'
  const end = parentAlign === 'MAX'

  if (axis === 'h') {
    if (stretch) result.push({ axis: 'h', type: 'leading', constant: values.start }, { axis: 'h', type: 'trailing', constant: values.end })
    else if (center) result.push({ axis: 'h', type: 'centerX', constant: values.center }, { axis: 'h', type: 'width', constant: frame.width })
    else if (end) result.push({ axis: 'h', type: 'trailing', constant: values.end }, { axis: 'h', type: 'width', constant: frame.width })
    else result.push({ axis: 'h', type: 'leading', constant: values.start }, { axis: 'h', type: 'width', constant: frame.width })
  } else {
    if (stretch) result.push({ axis: 'v', type: 'top', constant: values.start }, { axis: 'v', type: 'bottom', constant: values.end })
    else if (center) result.push({ axis: 'v', type: 'centerY', constant: values.center }, { axis: 'v', type: 'height', constant: frame.height })
    else if (end) result.push({ axis: 'v', type: 'bottom', constant: values.end }, { axis: 'v', type: 'height', constant: frame.height })
    else result.push({ axis: 'v', type: 'top', constant: values.start }, { axis: 'v', type: 'height', constant: frame.height })
  }
}

function inferPinnedConstraints(node, parent, frame) {
  const parentBox = bounds(parent)
  const right = round(Math.max(0, parentBox.width - frame.x - frame.width))
  const bottom = round(Math.max(0, parentBox.height - frame.y - frame.height))
  const centerX = round(frame.x + frame.width / 2 - parentBox.width / 2)
  const centerY = round(frame.y + frame.height / 2 - parentBox.height / 2)
  const figma = node.constraints || {}
  const horizontal = figma.horizontal || inferHorizontal(frame, parentBox.width, right)
  const vertical = figma.vertical || inferVertical(frame, parentBox.height, bottom)
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

function generateSwift(className, root) {
  const descendants = flatten(root).slice(1)
  const outletLines = descendants.map(node => `    @IBOutlet private weak var ${node.outlet}: ${swiftType(node)}!`).join('\n')
  const styleLines = generateSwiftStyleLines(root)
  return `import UIKit\n\nfinal class ${className}: UIView {\n    @IBOutlet private var contentView: UIView!${outletLines ? `\n${outletLines}` : ''}\n\n    override init(frame: CGRect) {\n        super.init(frame: frame)\n        commonInit()\n    }\n\n    required init?(coder: NSCoder) {\n        super.init(coder: coder)\n        commonInit()\n    }\n\n    private func commonInit() {\n        Bundle(for: Self.self).loadNibNamed(String(describing: Self.self), owner: self, options: nil)\n        guard let contentView else { return }\n        addSubview(contentView)\n        contentView.translatesAutoresizingMaskIntoConstraints = false\n        NSLayoutConstraint.activate([\n            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),\n            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),\n            contentView.topAnchor.constraint(equalTo: topAnchor),\n            contentView.bottomAnchor.constraint(equalTo: bottomAnchor)\n        ])\n        applyGeneratedStyle()\n    }\n\n    /// UIKitForge watches common UIKit assignments in this method and mirrors them in Web Preview.\n    /// Native validation remains the final source of truth once the macOS agent is connected.\n    private func applyGeneratedStyle() {\n${styleLines || '        // No runtime-only styles were required for this node.'}\n    }\n}\n`
}

function generateSwiftStyleLines(root) {
  const lines = []
  for (const [index, node] of flatten(root).entries()) {
    const target = index === 0 ? 'contentView' : node.outlet
    const style = node.style || {}
    if (style.background) lines.push(`        ${target}.backgroundColor = ${rgbaToSwift(style.background)}`)
    if (style.radius > 0) {
      lines.push(`        ${target}.layer.cornerRadius = ${formatNumber(style.radius)}`)
      lines.push(`        ${target}.layer.masksToBounds = true`)
    }
    if (style.borderColor && style.borderWidth > 0) {
      lines.push(`        ${target}.layer.borderColor = ${rgbaToSwift(style.borderColor)}.cgColor`)
      lines.push(`        ${target}.layer.borderWidth = ${formatNumber(style.borderWidth)}`)
    }
    if (style.opacity < 1) lines.push(`        ${target}.alpha = ${formatNumber(style.opacity)}`)
    if (node.kind === 'label') {
      lines.push(`        ${target}.text = ${swiftString(node.text)}`)
      if (style.textColor) lines.push(`        ${target}.textColor = ${rgbaToSwift(style.textColor)}`)
      lines.push(`        ${target}.font = .systemFont(ofSize: ${formatNumber(style.fontSize)}, weight: .${swiftFontWeight(style.fontWeight)})`)
      lines.push(`        ${target}.numberOfLines = ${style.numberOfLines}`)
    }
    if (style.shadow) {
      lines.push(`        ${target}.layer.shadowColor = ${rgbaToSwift(style.shadow.color || 'rgba(0, 0, 0, 0.2)')}.cgColor`)
      lines.push(`        ${target}.layer.shadowOpacity = ${formatNumber(alphaFromRgba(style.shadow.color || 'rgba(0,0,0,0.2)'))}`)
      lines.push(`        ${target}.layer.shadowOffset = CGSize(width: ${formatNumber(style.shadow.x)}, height: ${formatNumber(style.shadow.y)})`)
      lines.push(`        ${target}.layer.shadowRadius = ${formatNumber(style.shadow.blur / 2)}`)
      lines.push(`        ${target}.layer.masksToBounds = false`)
    }
  }
  return lines.join('\n')
}

function generateXib(className, root) {
  const descendants = flatten(root).slice(1)
  const outlets = [
    `                <outlet property="contentView" destination="${root.id}" id="out-content-${shortId(root.id)}"/>`,
    ...descendants.map(node => `                <outlet property="${xmlEscape(node.outlet)}" destination="${node.id}" id="out-${shortId(node.id)}"/>`)
  ].join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB" version="3.0" toolsVersion="23504" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" colorMatched="YES">\n    <device id="retina6_12" orientation="portrait" appearance="light"/>\n    <dependencies>\n        <deployment identifier="iOS"/>\n        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="23506"/>\n    </dependencies>\n    <objects>\n        <placeholder placeholderIdentifier="IBFilesOwner" id="-1" userLabel="File's Owner" customClass="${xmlEscape(className)}" customModuleProvider="target">\n            <connections>\n${outlets}\n            </connections>\n        </placeholder>\n        <placeholder placeholderIdentifier="IBFirstResponder" id="-2" customClass="UIResponder"/>\n${viewXml(root, true, 2)}\n    </objects>\n</document>\n`
}

function viewXml(node, isRoot, level) {
  if (node.kind === 'label') return labelXml(node, level, isRoot)
  if (node.kind === 'image') return imageXml(node, level, isRoot)

  const indent = '    '.repeat(level)
  const attrs = ['contentMode="scaleToFill"', 'translatesAutoresizingMaskIntoConstraints="NO"', `id="${node.id}"`, `userLabel="${xmlEscape(node.name)}"`]
  if (node.kind === 'component' && node.className) attrs.push(`customClass="${xmlEscape(node.className)}"`, 'customModuleProvider="target"')
  const childXml = node.children.map(child => viewXml(child, false, level + 2)).join('\n')
  const constraints = childConstraintXml(node, level + 2)
  const bg = colorXml('backgroundColor', node.style.background, level + 1)
  const subviewsBlock = childXml ? `${indent}    <subviews>\n${childXml}\n${indent}    </subviews>\n` : ''
  const constraintsBlock = constraints ? `${indent}    <constraints>\n${constraints}\n${indent}    </constraints>\n` : ''
  return `${indent}<view ${attrs.join(' ')}>\n${indent}    <rect key="frame" x="${formatNumber(isRoot ? 0 : node.frame.x)}" y="${formatNumber(isRoot ? 0 : node.frame.y)}" width="${formatNumber(node.frame.width)}" height="${formatNumber(node.frame.height)}"/>\n${subviewsBlock}${bg}${constraintsBlock}${indent}</view>`
}

function labelXml(node, level, isRoot = false) {
  const indent = '    '.repeat(level)
  const style = node.style
  const fontType = style.fontWeight >= 600 ? 'boldSystem' : 'system'
  const bg = colorXml('backgroundColor', style.background, level + 1)
  const textColor = colorXml('textColor', style.textColor || 'rgba(0, 0, 0, 1)', level + 1)
  return `${indent}<label opaque="NO" userInteractionEnabled="NO" contentMode="left" horizontalHuggingPriority="251" verticalHuggingPriority="251" text="${xmlEscape(node.text)}" textAlignment="${xibTextAlignment(style.textAlign)}" lineBreakMode="tailTruncation" numberOfLines="${style.numberOfLines}" baselineAdjustment="alignBaselines" adjustsFontSizeToFit="NO" translatesAutoresizingMaskIntoConstraints="NO" id="${node.id}" userLabel="${xmlEscape(node.name)}">\n${indent}    <rect key="frame" x="${formatNumber(isRoot ? 0 : node.frame.x)}" y="${formatNumber(isRoot ? 0 : node.frame.y)}" width="${formatNumber(node.frame.width)}" height="${formatNumber(node.frame.height)}"/>\n${indent}    <fontDescription key="fontDescription" type="${fontType}" pointSize="${formatNumber(style.fontSize)}"/>\n${textColor}${bg}${indent}    <nil key="highlightedColor"/>\n${indent}</label>`
}

function imageXml(node, level, isRoot = false) {
  const indent = '    '.repeat(level)
  const bg = colorXml('backgroundColor', node.style.background, level + 1)
  return `${indent}<imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFit" translatesAutoresizingMaskIntoConstraints="NO" id="${node.id}" userLabel="${xmlEscape(node.name)}">\n${indent}    <rect key="frame" x="${formatNumber(isRoot ? 0 : node.frame.x)}" y="${formatNumber(isRoot ? 0 : node.frame.y)}" width="${formatNumber(node.frame.width)}" height="${formatNumber(node.frame.height)}"/>\n${bg}${indent}</imageView>`
}

function colorXml(key, rgba, level) {
  if (!rgba) return ''
  const color = parseRgba(rgba)
  if (!color) return ''
  const indent = '    '.repeat(level)
  return `${indent}<color key="${key}" red="${unit(color.r)}" green="${unit(color.g)}" blue="${unit(color.b)}" alpha="${unit(color.a)}" colorSpace="custom" customColorSpace="sRGB"/>\n`
}

function childConstraintXml(parent, level) {
  const indent = '    '.repeat(level)
  const rows = []
  const byFigmaId = new Map(parent.children.map(child => [child.figmaId, child]))
  for (const child of parent.children) {
    for (const constraint of child.constraints || []) {
      const id = `c-${shortId(parent.id)}-${shortId(child.id)}-${constraint.type}`
      if (constraint.type === 'leading') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="leading" secondItem="${parent.id}" secondAttribute="leading" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'trailing') rows.push(`${indent}<constraint firstItem="${parent.id}" firstAttribute="trailing" secondItem="${child.id}" secondAttribute="trailing" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'top') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="top" secondItem="${parent.id}" secondAttribute="top" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'bottom') rows.push(`${indent}<constraint firstItem="${parent.id}" firstAttribute="bottom" secondItem="${child.id}" secondAttribute="bottom" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'centerX') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="centerX" secondItem="${parent.id}" secondAttribute="centerX" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'centerY') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="centerY" secondItem="${parent.id}" secondAttribute="centerY" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'width') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="width" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'height') rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="height" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      else if (constraint.type === 'leadingToTrailing') {
        const target = byFigmaId.get(constraint.targetFigmaId)
        if (target) rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="leading" secondItem="${target.id}" secondAttribute="trailing" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      } else if (constraint.type === 'topToBottom') {
        const target = byFigmaId.get(constraint.targetFigmaId)
        if (target) rows.push(`${indent}<constraint firstItem="${child.id}" firstAttribute="top" secondItem="${target.id}" secondAttribute="bottom" constant="${formatNumber(constraint.constant)}" id="${id}"/>`)
      }
    }
  }
  return rows.join('\n')
}

function collectLayoutWarnings(root) {
  const warnings = []
  for (const node of flatten(root)) {
    if (node !== root && !hasTwoAxisConstraints(node.constraints || [])) warnings.push(`${node.name}: UIKitForge could not infer a complete two-axis Auto Layout rule.`)
    if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') warnings.push(`${node.name}: vector geometry is still represented as a UIView placeholder; SVG/PDF asset export is the next compiler stage.`)
    if (node.kind === 'image') warnings.push(`${node.name}: image fill is represented as UIImageView but the binary asset is not exported yet.`)
    if (node.meta?.preservesChildrenOverImageFill) warnings.push(`${node.name}: Figma uses an image fill on a container. UIKitForge preserved its child hierarchy instead of collapsing the container into UIImageView; the background image asset is not exported yet.`)
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

function parseRgba(value) {
  const match = String(value || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i)
  if (!match) return null
  return { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255, a: match[4] == null ? 1 : Number(match[4]) }
}

function alphaFromRgba(value) { return parseRgba(value)?.a ?? 1 }
function unit(value) { return Number(Math.max(0, Math.min(1, value)).toFixed(5)) }
function normalizeFontWeight(weight) { const n = Number(weight); return Number.isFinite(n) ? Math.max(100, Math.min(900, n)) : 400 }
function swiftFontWeight(weight) { if (weight >= 800) return 'heavy'; if (weight >= 700) return 'bold'; if (weight >= 600) return 'semibold'; if (weight >= 500) return 'medium'; if (weight <= 300) return 'light'; return 'regular' }
function swiftString(value) { return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` }
function xibTextAlignment(value) { if (value === 'center') return 'center'; if (value === 'right') return 'right'; if (value === 'justified') return 'justified'; return 'natural' }
function xmlEscape(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
function xibId(value) { const cleaned = String(value || '').replace(/[^A-Za-z0-9]/g, ''); return `UF-${(cleaned || cryptoSafeId()).slice(-12)}` }
function shortId(value) { return String(value || '').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'node' }
function cryptoSafeId() { return Math.random().toString(36).slice(2, 12) }
function round(value) { return Number(Number(value || 0).toFixed(2)) }
function formatNumber(value) { return Number(Number(value || 0).toFixed(2)).toString() }
