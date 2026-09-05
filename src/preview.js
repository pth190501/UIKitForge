export function clonePreviewTree(root) {
  return typeof structuredClone === 'function'
    ? structuredClone(root)
    : JSON.parse(JSON.stringify(root))
}

export function applySwiftPreview(sourceRoot, swiftCode) {
  const root = clonePreviewTree(sourceRoot)
  const targets = new Map([['contentView', root]])
  walkPreview(root, node => {
    if (node !== root && node.outlet) targets.set(node.outlet, node)
  })

  for (const [targetName, node] of targets) {
    const escaped = escapeRegExp(targetName)
    const style = node.style || (node.style = {})

    const background = matchColor(swiftCode, `${escaped}\\.backgroundColor`)
    if (background) style.background = background

    const textColor = matchColor(swiftCode, `${escaped}\\.textColor`)
    if (textColor) style.textColor = textColor

    const borderColor = matchColor(swiftCode, `${escaped}\\.layer\\.borderColor`, true)
    if (borderColor) style.borderColor = borderColor

    const radius = matchNumber(swiftCode, `${escaped}\\.layer\\.cornerRadius`)
    if (radius != null) style.radius = radius

    const borderWidth = matchNumber(swiftCode, `${escaped}\\.layer\\.borderWidth`)
    if (borderWidth != null) style.borderWidth = borderWidth

    const alpha = matchNumber(swiftCode, `${escaped}\\.alpha`)
    if (alpha != null) style.opacity = alpha

    const hidden = matchBoolean(swiftCode, `${escaped}\\.isHidden`)
    if (hidden != null) node.hidden = hidden

    if (node.kind === 'label') {
      const text = matchSwiftString(swiftCode, `${escaped}\\.text`)
      if (text != null) node.text = text

      const lines = matchNumber(swiftCode, `${escaped}\\.numberOfLines`)
      if (lines != null) style.numberOfLines = lines

      const font = matchFont(swiftCode, escaped)
      if (font) {
        style.fontSize = font.size
        style.fontWeight = font.weight
      }
    }
  }

  return root
}

export function renderUIKitPreview(container, root, options = {}) {
  if (!container || !root) return
  const { selectedId = null, onSelect = null, referenceImage = null, overlayOpacity = 0 } = options
  container.innerHTML = ''

  const viewport = document.createElement('div')
  viewport.className = 'preview-viewport'

  const rootWidth = Math.max(1, root.frame?.width || 390)
  const rootHeight = Math.max(1, root.frame?.height || 844)
  const availableWidth = Math.max(220, container.clientWidth - 48)
  const availableHeight = Math.max(320, container.clientHeight - 48)
  const scale = Math.min(1.35, availableWidth / rootWidth, availableHeight / rootHeight)

  const stageShell = document.createElement('div')
  stageShell.className = 'preview-stage-shell'
  stageShell.style.width = `${rootWidth * scale}px`
  stageShell.style.height = `${rootHeight * scale}px`

  const stage = document.createElement('div')
  stage.className = 'preview-stage'
  stage.style.width = `${rootWidth}px`
  stage.style.height = `${rootHeight}px`
  stage.style.transform = `scale(${scale})`
  stage.style.transformOrigin = 'top left'

  const uiRoot = renderNode(root, true, selectedId, onSelect)
  stage.appendChild(uiRoot)

  if (referenceImage) {
    const image = document.createElement('img')
    image.className = 'reference-overlay'
    image.src = referenceImage
    image.alt = 'Reference'
    image.style.opacity = String(Math.max(0, Math.min(1, overlayOpacity)))
    stage.appendChild(image)
  }

  stageShell.appendChild(stage)
  viewport.appendChild(stageShell)
  container.appendChild(viewport)
}

function renderNode(node, isRoot, selectedId, onSelect) {
  const element = document.createElement('div')
  element.className = `uikit-node uikit-${node.kind || 'view'}`
  element.dataset.figmaId = node.figmaId || ''
  element.dataset.outlet = node.outlet || ''
  element.title = `${node.name || 'View'}${node.outlet ? ` · ${node.outlet}` : ''}`

  if (node.hidden) element.style.display = 'none'

  if (isRoot) {
    element.style.left = '0px'
    element.style.top = '0px'
    element.style.width = '100%'
    element.style.height = '100%'
  } else {
    const frame = node.frame || {}
    element.style.left = `${frame.x || 0}px`
    element.style.top = `${frame.y || 0}px`
    element.style.width = `${Math.max(0, frame.width || 0)}px`
    element.style.height = `${Math.max(0, frame.height || 0)}px`
  }

  applyNodeStyle(element, node)

  if (node.kind === 'label') {
    element.textContent = node.text || ''
  } else if (node.kind === 'image') {
    const badge = document.createElement('span')
    badge.className = 'image-placeholder'
    badge.textContent = 'IMG'
    element.appendChild(badge)
  }

  if (node.kind === 'component' && node.className) {
    element.dataset.component = node.className
  }

  if (node.id === selectedId) element.classList.add('is-selected')

  element.addEventListener('click', event => {
    event.stopPropagation()
    onSelect?.(node)
  })

  const visualChildren = node.children?.length ? node.children : (node.previewChildren || [])
  for (const child of visualChildren) {
    element.appendChild(renderNode(child, false, selectedId, onSelect))
  }

  return element
}

function applyNodeStyle(element, node) {
  const style = node.style || {}
  element.style.opacity = style.opacity == null ? '1' : String(style.opacity)
  if (style.background) element.style.background = style.background
  if (style.radius) element.style.borderRadius = `${style.radius}px`
  if (style.borderColor && style.borderWidth) element.style.border = `${style.borderWidth}px solid ${style.borderColor}`

  if (style.shadow) {
    const shadow = style.shadow
    element.style.boxShadow = `${shadow.x || 0}px ${shadow.y || 0}px ${Math.max(0, shadow.blur || 0)}px ${shadow.spread || 0}px ${shadow.color || 'rgba(0,0,0,.2)'}`
  }

  if (node.kind === 'label') {
    element.style.color = style.textColor || '#111827'
    element.style.fontFamily = systemFontStack(style.fontFamily)
    element.style.fontSize = `${style.fontSize || 14}px`
    element.style.fontWeight = String(style.fontWeight || 400)
    if (style.lineHeight > 0) element.style.lineHeight = `${style.lineHeight}px`
    element.style.textAlign = cssTextAlign(style.textAlign)
    element.style.display = '-webkit-box'
    element.style.webkitBoxOrient = 'vertical'
    element.style.overflow = 'hidden'
    if (style.numberOfLines > 0) element.style.webkitLineClamp = String(style.numberOfLines)
  }

  if (node.kind === 'component') {
    element.classList.add('component-boundary')
  }
}

export function walkPreview(root, visitor) {
  visitor(root)
  const children = root.children?.length ? root.children : (root.previewChildren || [])
  for (const child of children) walkPreview(child, visitor)
}

export function describeNode(node) {
  if (!node) return null
  return {
    name: node.name,
    outlet: node.outlet || 'contentView',
    type: node.type,
    kind: node.kind,
    className: node.className,
    frame: node.frame,
    constraints: node.constraints || [],
    style: node.style || {}
  }
}

function matchColor(source, lhsPattern, allowsCgColor = false) {
  const suffix = allowsCgColor ? '(?:\\.cgColor)?' : ''
  const pattern = new RegExp(`${lhsPattern}\\s*=\\s*UIColor\\(red:\\s*([\\d.]+),\\s*green:\\s*([\\d.]+),\\s*blue:\\s*([\\d.]+),\\s*alpha:\\s*([\\d.]+)\\)${suffix}`)
  const match = source.match(pattern)
  if (!match) return null
  return `rgba(${Math.round(Number(match[1]) * 255)}, ${Math.round(Number(match[2]) * 255)}, ${Math.round(Number(match[3]) * 255)}, ${Number(match[4])})`
}

function matchNumber(source, lhsPattern) {
  const match = source.match(new RegExp(`${lhsPattern}\\s*=\\s*(-?[\\d.]+)`))
  return match ? Number(match[1]) : null
}

function matchBoolean(source, lhsPattern) {
  const match = source.match(new RegExp(`${lhsPattern}\\s*=\\s*(true|false)`))
  return match ? match[1] === 'true' : null
}

function matchSwiftString(source, lhsPattern) {
  const match = source.match(new RegExp(`${lhsPattern}\\s*=\\s*\"((?:\\\\.|[^\"\\\\])*)\"`))
  if (!match) return null
  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function matchFont(source, escapedTarget) {
  const pattern = new RegExp(`${escapedTarget}\\.font\\s*=\\s*\\.systemFont\\(ofSize:\\s*([\\d.]+),\\s*weight:\\s*\\.([A-Za-z]+)\\)`)
  const match = source.match(pattern)
  if (!match) return null
  return { size: Number(match[1]), weight: fontWeightNumber(match[2]) }
}

function fontWeightNumber(value) {
  const map = { ultraLight: 100, thin: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 }
  return map[value] || 400
}

function systemFontStack(fontFamily) {
  if (!fontFamily || /system|sf pro/i.test(fontFamily)) return '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif'
  return `"${String(fontFamily).replace(/"/g, '')}", -apple-system, BlinkMacSystemFont, sans-serif`
}

function cssTextAlign(value) {
  if (value === 'right') return 'right'
  if (value === 'center') return 'center'
  if (value === 'justified') return 'justify'
  return 'left'
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
