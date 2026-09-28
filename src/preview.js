import { arrangedChildStyle, isArrangedChild, resolveStack, sizingOf, stackContainerStyle } from './preview-layout.js'

// Element → node đã render, để đo lại layout thật (flexbox) cho pixel-diff mà không phụ thuộc id (component lặp lại dùng chung id).
const renderedNodes = new WeakMap()

export function clonePreviewTree(root) {
  return typeof structuredClone === 'function'
    ? structuredClone(root)
    : JSON.parse(JSON.stringify(root))
}

// namedColors: { assetName: 'rgba(...)' } từ color registry — code sinh ra dùng UIColor(named:) nên cần bảng
// này mới dịch ngược được màu về preview; tên asset lạ (user tự gõ) thì bỏ qua, giữ style gốc.
export function applySwiftPreview(sourceRoot, swiftCode, { namedColors = {} } = {}) {
  const root = clonePreviewTree(sourceRoot)
  const targets = new Map([['contentView', root]])
  // Không đi vào bên trong component: outlet bên trong thuộc file Swift của component, trùng tên với outlet
  // màn chính (vd `title`) sẽ làm phép gán của màn chính rơi nhầm vào view con của component.
  const collect = node => {
    if (node !== root && node.outlet && !targets.has(node.outlet)) targets.set(node.outlet, node)
    if (node !== root && node.kind === 'component') return
    for (const child of node.children?.length ? node.children : (node.previewChildren || [])) collect(child)
  }
  collect(root)

  for (const [targetName, node] of targets) {
    // (?<![\w.]) chặn match nhầm outlet trùng hậu tố (title vs subtitle.x). Root: biến thể XIB gán qua
    // `contentView.`, biến thể Code gán thẳng trên self (`backgroundColor = ...`) nên tiền tố là optional.
    const prefix = node === root
      ? '(?<![\\w.])(?:contentView\\.)?'
      : `(?<![\\w.])${escapeRegExp(targetName)}\\.`
    const style = node.style || (node.style = {})

    const background = matchColor(swiftCode, `${prefix}backgroundColor`, namedColors)
    if (background) style.background = background

    const textColor = matchColor(swiftCode, `${prefix}textColor`, namedColors)
    if (textColor) style.textColor = textColor

    const borderColor = matchColor(swiftCode, `${prefix}layer\\.borderColor`, namedColors)
    if (borderColor) style.borderColor = borderColor

    const radius = matchNumber(swiftCode, `${prefix}layer\\.cornerRadius`)
    if (radius != null) style.radius = radius

    const borderWidth = matchNumber(swiftCode, `${prefix}layer\\.borderWidth`)
    if (borderWidth != null) style.borderWidth = borderWidth

    const alpha = matchNumber(swiftCode, `${prefix}alpha`)
    if (alpha != null) style.opacity = alpha

    const hidden = matchBoolean(swiftCode, `${prefix}isHidden`)
    if (hidden != null) node.hidden = hidden

    if (node.kind === 'label') {
      const text = matchSwiftString(swiftCode, `${prefix}text`)
      if (text != null) node.text = text

      const lines = matchNumber(swiftCode, `${prefix}numberOfLines`)
      if (lines != null) style.numberOfLines = lines

      const font = matchFont(swiftCode, `${prefix}font`)
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

  const {
    selectedId = null,
    onSelect = null,
    referenceImage = null,
    overlayOpacity = 0,
    zoom = 'fit',
    showGrid = true,
    showOutlines = false,
    showSafeArea = false,
    onMetrics = null
  } = options

  container.innerHTML = ''
  container.classList.toggle('grid-enabled', Boolean(showGrid))
  container.classList.toggle('outlines-enabled', Boolean(showOutlines))

  const rootWidth = Math.max(1, root.frame?.width || 390)
  const rootHeight = Math.max(1, root.frame?.height || 844)
  const availableWidth = Math.max(240, container.clientWidth - 72)
  const availableHeight = Math.max(340, container.clientHeight - 96)
  const fitScale = Math.min(1.6, availableWidth / rootWidth, availableHeight / rootHeight)
  const scale = zoom === 'fit'
    ? fitScale
    : Math.max(0.2, Math.min(3, Number(zoom) || 1))

  const phoneLike = rootWidth >= 300 && rootWidth <= 500 && rootHeight / rootWidth >= 1.55

  const viewport = document.createElement('div')
  viewport.className = 'preview-viewport'

  const board = document.createElement('div')
  board.className = `preview-board ${phoneLike ? 'is-device' : 'is-artboard'}`

  const caption = document.createElement('div')
  caption.className = 'preview-board-caption'
  caption.innerHTML = `<span>${escapeHtml(root.name || 'UIKit View')}</span><strong>${formatNumber(rootWidth)} × ${formatNumber(rootHeight)}</strong>`
  board.appendChild(caption)

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
  // Root HUG theo chiều dọc (vd card) co giãn theo nội dung như UIView tự co bằng Auto Layout — không khoá cao theo Figma.
  const hugsHeight = sizingOf(root).v === 'HUG' && Boolean(resolveStack(root))
  if (hugsHeight) uiRoot.style.height = 'auto'
  stage.appendChild(uiRoot)

  if (showSafeArea && phoneLike) {
    const safeArea = document.createElement('div')
    safeArea.className = 'safe-area-guide'
    stage.appendChild(safeArea)
  }

  if (referenceImage) {
    const image = document.createElement('img')
    image.className = 'reference-overlay'
    image.src = referenceImage
    image.alt = 'Reference'
    image.style.opacity = String(Math.max(0, Math.min(1, overlayOpacity)))
    stage.appendChild(image)
  }

  stageShell.appendChild(stage)
  board.appendChild(stageShell)

  const metrics = document.createElement('div')
  metrics.className = 'preview-board-metrics'
  metrics.innerHTML = `<span>${Math.round(scale * 100)}%</span><span>${countVisibleNodes(root)} layers</span>${phoneLike ? '<span>iOS canvas</span>' : '<span>artboard</span>'}`
  board.appendChild(metrics)

  viewport.appendChild(board)
  container.appendChild(viewport)
  if (hugsHeight) {
    const contentHeight = Math.max(1, uiRoot.offsetHeight)
    stage.style.height = `${contentHeight}px`
    stageShell.style.height = `${contentHeight * scale}px`
  }
  onMetrics?.({ scale, fitScale, rootWidth, rootHeight, phoneLike })
}

function renderNode(node, isRoot, selectedId, onSelect, parentStack = null) {
  const element = document.createElement('div')
  element.className = `uikit-node uikit-${node.kind || 'view'}`
  element.dataset.nodeId = node.id || ''
  element.dataset.figmaId = node.figmaId || ''
  element.dataset.outlet = node.outlet || ''
  element.dataset.nodeName = node.name || ''
  element.title = `${node.name || 'View'}${node.outlet ? ` · ${node.outlet}` : ''}`

  if (isRoot) {
    element.style.left = '0px'
    element.style.top = '0px'
    element.style.width = '100%'
    element.style.height = '100%'
  } else if (parentStack && isArrangedChild(node)) {
    Object.assign(element.style, arrangedChildStyle(node, parentStack))
  } else {
    const frame = node.frame || {}
    element.style.left = `${frame.x || 0}px`
    element.style.top = `${frame.y || 0}px`
    element.style.width = `${Math.max(0, frame.width || 0)}px`
    element.style.height = `${Math.max(0, frame.height || 0)}px`
  }

  applyNodeStyle(element, node)
  renderedNodes.set(element, node)

  const stack = node.kind === 'label' ? null : resolveStack(node)
  if (stack) Object.assign(element.style, stackContainerStyle(stack))
  // Đặt sau cùng: style label (-webkit-box) và stack (flex) đều ghi đè `display`. Ẩn cũng rút khỏi luồng flex như UIStackView.
  if (node.hidden) element.style.display = 'none'

  if (node.kind === 'label') {
    renderLabelText(element, node)
  } else if (node.kind === 'image' && !node.style?.imageUrl) {
    const badge = document.createElement('span')
    badge.className = 'image-placeholder'
    badge.innerHTML = '<span class="image-placeholder-icon">▧</span><span>IMAGE</span>'
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
    element.appendChild(renderNode(child, false, selectedId, onSelect, stack))
  }

  return element
}

// Đoạn khác weight (giống NSAttributedString / Text + Text đã sinh) → <span> riêng. Chỉ dùng khi các đoạn ghép lại
// đúng bằng text hiện tại: instance override đổi text thì offset cũ vô nghĩa, quay về text thường.
const CSS_DECORATION = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }

function renderLabelText(element, node) {
  const text = node.text || ''
  const runs = node.textRuns
  if (!runs?.length || runs.map(run => run.text).join('') !== text) {
    element.textContent = text
    return
  }
  for (const run of runs) {
    const span = document.createElement('span')
    span.textContent = run.text
    if (run.fontWeight !== node.style?.fontWeight) span.style.fontWeight = String(run.fontWeight)
    if (run.color) span.style.color = run.color
    span.style.textDecoration = CSS_DECORATION[run.decoration] || 'none'
    element.appendChild(span)
  }
}

function applyNodeStyle(element, node) {
  const style = node.style || {}
  element.style.opacity = style.opacity == null ? '1' : String(style.opacity)

  if (style.background) element.style.background = style.background
  if (style.imageUrl) {
    element.style.backgroundImage = `url("${String(style.imageUrl).replace(/"/g, '%22')}")`
    element.style.backgroundRepeat = 'no-repeat'
    element.style.backgroundPosition = 'center'
    element.style.backgroundSize = imageScaleMode(style.imageScaleMode)
  }

  // CSS border-radius 4 giá trị cùng thứ tự với Figma rectangleCornerRadii (trên-trái → dưới-trái theo chiều kim đồng hồ).
  if (style.cornerRadii?.length === 4) element.style.borderRadius = style.cornerRadii.map(value => `${value}px`).join(' ')
  else if (style.radius) element.style.borderRadius = `${style.radius}px`
  if (style.borderColor && style.borderWidth) element.style.border = `${style.borderWidth}px solid ${style.borderColor}`
  // Bo góc không đồng nghĩa với clip (UIKit/Figma đều vậy) — chỉ cắt khi clipsContent, còn ảnh thì cần bo theo góc.
  if (style.clipsContent || (style.radius && node.kind === 'image')) element.style.overflow = 'hidden'

  const shadows = []
  if (style.shadow) {
    const shadow = style.shadow
    shadows.push(`${shadow.x || 0}px ${shadow.y || 0}px ${Math.max(0, shadow.blur || 0)}px ${shadow.spread || 0}px ${shadow.color || 'rgba(0,0,0,.2)'}`)
  }
  if (style.innerShadow) {
    const shadow = style.innerShadow
    shadows.push(`inset ${shadow.x || 0}px ${shadow.y || 0}px ${Math.max(0, shadow.blur || 0)}px ${shadow.spread || 0}px ${shadow.color || 'rgba(0,0,0,.25)'}`)
  }
  if (shadows.length) element.style.boxShadow = shadows.join(', ')
  // Figma blur radius ≈ gấp đôi độ lệch chuẩn CSS blur().
  if (style.backgroundBlur) element.style.backdropFilter = `blur(${style.backgroundBlur / 2}px)`
  if (style.layerBlur) element.style.filter = `blur(${style.layerBlur / 2}px)`

  if (node.kind === 'label') {
    element.style.color = style.textColor || '#111827'
    element.style.fontFamily = systemFontStack(style.fontFamily)
    element.style.fontSize = `${style.fontSize || 14}px`
    element.style.fontWeight = String(style.fontWeight || 400)
    if (style.lineHeight > 0) element.style.lineHeight = `${style.lineHeight}px`
    if (style.letterSpacing) element.style.letterSpacing = `${style.letterSpacing}px`
    // CSS text-decoration của cha lan xuống con và con không tắt được — có runs thì để từng <span> tự gạch.
    if (style.textDecoration && !node.textRuns) element.style.textDecoration = CSS_DECORATION[style.textDecoration]
    element.style.textAlign = cssTextAlign(style.textAlign)
    element.style.display = '-webkit-box'
    element.style.webkitBoxOrient = 'vertical'
    element.style.overflow = 'hidden'
    if (style.numberOfLines > 0) element.style.webkitLineClamp = String(style.numberOfLines)
  }

  if (node.kind === 'component') element.classList.add('component-boundary')
}

// Raster hoá preview tree lên canvas ngoài màn hình để so pixel với ảnh tham chiếu (xem pixel-diff.js).
// Cố ý không dùng html2canvas (tránh thêm dependency): tự vẽ rect/radius/text xấp xỉ từ cùng style
// engine với renderNode, đủ để so khớp bố cục/màu sắc dù không render font hệt hệ điều hành.
// Đo vị trí thật (sau flexbox) của mọi node đang hiển thị, theo toạ độ chưa scale của stage.
// Trả về WeakMap node → rect; null nếu preview chưa render.
export function measurePreviewLayout(container) {
  const stage = container?.querySelector('.preview-stage')
  if (!stage) return null
  const stageRect = stage.getBoundingClientRect()
  const scale = stage.offsetWidth ? stageRect.width / stage.offsetWidth : 1
  const rects = new WeakMap()
  for (const element of stage.querySelectorAll('.uikit-node')) {
    const node = renderedNodes.get(element)
    if (!node) continue
    const rect = element.getBoundingClientRect()
    rects.set(node, {
      x: (rect.left - stageRect.left) / scale,
      y: (rect.top - stageRect.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale
    })
  }
  return rects
}

// layout (tuỳ chọn): kết quả measurePreviewLayout — có thì vẽ đúng vị trí flexbox, không thì dùng frame Figma.
export function rasterizePreviewToCanvas(root, width, height, layout = null) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawNodeToCanvas(ctx, root, 0, 0, true, layout)
  return canvas
}

function drawNodeToCanvas(ctx, node, offsetX, offsetY, isRoot, layout) {
  if (node.hidden) return
  const frame = node.frame || {}
  const measured = layout?.get(node)
  const x = measured ? measured.x : isRoot ? 0 : offsetX + (frame.x || 0)
  const y = measured ? measured.y : isRoot ? 0 : offsetY + (frame.y || 0)
  const w = Math.max(0, measured ? measured.width : frame.width || ctx.canvas.width)
  const h = Math.max(0, measured ? measured.height : frame.height || ctx.canvas.height)
  const style = node.style || {}

  ctx.save()
  ctx.globalAlpha = style.opacity == null ? 1 : Math.max(0, Math.min(1, style.opacity))

  if (style.radius > 0) roundedRectPath(ctx, x, y, w, h, style.radius)
  else ctx.rect(x, y, w, h)

  if (style.background && !style.imageUrl) {
    ctx.fillStyle = cssColorToCanvasFill(style.background)
    ctx.fill()
  }

  if (style.borderColor && style.borderWidth) {
    ctx.lineWidth = style.borderWidth
    ctx.strokeStyle = style.borderColor
    ctx.stroke()
  }
  ctx.restore()

  if (node.kind === 'label' && node.text) {
    ctx.save()
    ctx.globalAlpha = style.opacity == null ? 1 : Math.max(0, Math.min(1, style.opacity))
    ctx.fillStyle = style.textColor || 'rgba(17, 24, 39, 1)'
    ctx.font = `${style.fontWeight >= 600 ? 'bold' : 'normal'} ${style.fontSize || 14}px -apple-system, sans-serif`
    ctx.textBaseline = 'top'
    ctx.textAlign = style.textAlign === 'center' ? 'center' : style.textAlign === 'right' ? 'right' : 'left'
    const textX = ctx.textAlign === 'center' ? x + w / 2 : ctx.textAlign === 'right' ? x + w : x
    ctx.fillText(String(node.text), textX, y, w)
    ctx.restore()
  }

  const children = node.children?.length ? node.children : (node.previewChildren || [])
  for (const child of children) drawNodeToCanvas(ctx, child, x, y, false, layout)
}

function roundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function cssColorToCanvasFill(value) {
  return value // rgba()/linear-gradient() string đã hợp lệ với fillStyle; gradient phức tạp sẽ fallback màu đầu do canvas 2D parse fill string trực tiếp
}

export function walkPreview(root, visitor) {
  visitor(root)
  const children = root.children?.length ? root.children : (root.previewChildren || [])
  for (const child of children) walkPreview(child, visitor)
}

export function describeNode(node) {
  if (!node) return null
  return {
    id: node.id,
    figmaId: node.figmaId,
    name: node.name,
    outlet: node.outlet || 'contentView',
    type: node.type,
    kind: node.kind,
    className: node.className,
    frame: node.frame || {},
    constraints: node.constraints || [],
    style: node.style || {},
    layout: node.layout || {},
    meta: node.meta || {}
  }
}

function countVisibleNodes(root) {
  let count = 0
  walkPreview(root, node => {
    if (!node.hidden) count += 1
  })
  return count
}

function imageScaleMode(value) {
  const mode = String(value || '').toUpperCase()
  if (mode === 'FIT') return 'contain'
  if (mode === 'TILE') return 'auto'
  return 'cover'
}

// Một regex cho cả literal UIColor(red:...) lẫn UIColor(named:) để phép gán xuất hiện trước thắng, như cũ.
function matchColor(source, lhsPattern, namedColors = {}) {
  const pattern = new RegExp(`${lhsPattern}\\s*=\\s*UIColor\\((?:red:\\s*([\\d.]+),\\s*green:\\s*([\\d.]+),\\s*blue:\\s*([\\d.]+),\\s*alpha:\\s*([\\d.]+)|named:\\s*"([^"]+)")\\)`)
  const match = source.match(pattern)
  if (!match) return null
  if (match[5] != null) return Object.hasOwn(namedColors, match[5]) ? namedColors[match[5]] : null
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

// Chấp nhận cả `.systemFont(...)` trần lẫn bản bọc UIFontMetrics(...).scaledFont(for: UIFont.systemFont(...))
// (Dynamic Type). Chỉ cho vượt dòng khi dòng sau là continuation bắt đầu bằng `.` (vd `.scaledFont(for:`),
// để không bắt nhầm font của câu lệnh khác.
function matchFont(source, lhsPattern) {
  const pattern = new RegExp(`${lhsPattern}\\s*=(?:[^\\n]|\\n\\s*(?=\\.))*?systemFont\\(ofSize:\\s*([\\d.]+),\\s*weight:\\s*\\.([A-Za-z]+)\\)`)
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Number(number.toFixed(1)).toString() : '—'
}
