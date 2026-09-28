import { findComponentCandidates, firstVisibleSolidPaint, isRasterCandidate } from './figma.js'
import { createColorRegistry } from './color-registry.js'
import { foldDiacritics, joinWordsCapped } from './identifier.js'

const VIEW_TYPES = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT',
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

  for (const { componentId, node, all } of candidates.instances) {
    // Component chỉ là icon/hình vẽ (vd Wallet, Chevron) → xuất ảnh thay vì sinh class UIView rỗng.
    if (node.id === sourceRoot.id || isRasterCandidate(node)) continue
    let className = sanitizeClassName(`${node.name || 'Component'}View`, 'GeneratedComponentView')
    className = uniqueClassName(className, usedNames)
    componentMap.set(componentId, { className, source: node, instances: (all || [node]).filter(item => item.id !== sourceRoot.id) })
  }

  const colorRegistry = createColorRegistry({ names: options.colorNames })
  const files = []
  const components = []
  const componentIRs = []
  const builtComponents = []
  for (const [componentId, entry] of componentMap.entries()) {
    const ir = buildIR(entry.source, null, componentMap, { skipComponentForNodeId: entry.source.id })
    dedupeOutlets(ir)
    ensureUniqueIds(ir)
    ir.slots = componentSlots(ir, entry)
    builtComponents.push({ componentId, entry, ir })
  }
  const mainIR = buildIR(sourceRoot, null, componentMap, { skipComponentForNodeId: sourceRoot.id })
  dedupeOutlets(mainIR)
  ensureUniqueIds(mainIR)
  // Mỗi instance mang nội dung riêng (text/ẩn-hiện khác instance gốc) → gắn overrides để code gọi configure.
  const rawById = indexRawTree(sourceRoot)
  const slotsByClass = new Map(builtComponents.map(({ entry, ir }) => [entry.className, ir.slots]))
  for (const ir of [mainIR, ...builtComponents.map(item => item.ir)]) annotateInstanceOverrides(ir, rawById, slotsByClass)

  // Component tên kiểu nút (Button/Btn/CTA/Nút) → UIControl + Button SwiftUI; view cha mở closure onXxxTap.
  const buttonClasses = new Set(builtComponents.filter(({ entry }) => isButtonName(entry.source.name)).map(({ entry }) => entry.className))
  for (const { entry, ir } of builtComponents) ir.meta.isButton = buttonClasses.has(entry.className)
  const finishSwift = (swift, ir, slots = null) => withGradientHelper(withButtonActions(asButtonControl(slots ? withConfigure(swift, slots) : swift, ir), ir, buttonClasses))

  for (const { componentId, entry, ir } of builtComponents) {
    files.push(
      { path: `Components/${entry.className}/${entry.className}.swift`, name: `${entry.className}.swift`, language: 'swift', content: finishSwift(generateSwift(entry.className, ir, colorRegistry), ir, ir.slots), kind: 'component', target: 'uikit-xib' },
      { path: `Components/${entry.className}/${entry.className}.xib`, name: `${entry.className}.xib`, language: 'xml', content: generateXib(entry.className, ir, deploymentTarget), kind: 'component', target: 'uikit-xib' },
      { path: `UIKit-Code/Components/${entry.className}/${entry.className}.swift`, name: `${entry.className}.swift`, language: 'swift', content: finishSwift(generateSwiftProgrammatic(entry.className, ir, colorRegistry), ir, ir.slots), kind: 'component', target: 'uikit-code' }
    )
    components.push({ componentId, className: entry.className, sourceName: entry.source.name || 'Component', sourceId: entry.source.id })
    componentIRs.push({ className: entry.className, ir })
  }

  files.unshift(
    { path: `${rootClass}/${rootClass}.xib`, name: `${rootClass}.xib`, language: 'xml', content: generateXib(rootClass, mainIR, deploymentTarget), kind: 'main', target: 'uikit-xib' },
    { path: `${rootClass}/${rootClass}.swift`, name: `${rootClass}.swift`, language: 'swift', content: finishSwift(generateSwift(rootClass, mainIR, colorRegistry), mainIR), kind: 'main', target: 'uikit-xib' },
    { path: `UIKit-Code/${rootClass}/${rootClass}.swift`, name: `${rootClass}.swift`, language: 'swift', content: finishSwift(generateSwiftProgrammatic(rootClass, mainIR, colorRegistry), mainIR), kind: 'main', target: 'uikit-code' }
  )

  warnings.push(...collectLayoutWarnings(mainIR))
  for (const type of collectUnknownContainerTypes(sourceRoot)) {
    warnings.push(`Figma node type ${type} is not natively supported; it was compiled as a plain container UIView with its children kept.`)
  }
  if (colorRegistry.entries().length) {
    warnings.push('Colors.xcassets was generated with the Dark Appearance set to the same value as Any Appearance (Figma has no dark variant). Edit the color sets in Xcode for a real dark palette.')
  }
  return {
    rootClass, deploymentTarget, sourceRoot, previewRoot: mainIR, files, components, componentIRs,
    colorRegistry, colors: colorRegistry.entries(), warnings: [...new Set(warnings)],
    scroll: scrollInfo(sourceRoot, mainIR)
  }
}

// iPhone cao nhất (Pro Max) là 932pt — khung Figma cao hơn thì chắc chắn phải cuộn; hoặc designer bật scroll dọc.
const MAX_DEVICE_HEIGHT = 932

// Màn hình cần cuộn dọc → VC/SwiftUI bọc view thiết kế trong scroll view. fixedHeight: khung Figma cố định (không
// hug nội dung) thì phải ghim đúng chiều cao, nếu không scroll view không biết content cao bao nhiêu.
export function scrollInfo(sourceRoot, mainIR) {
  const vertical = /VERTICAL/.test(String(sourceRoot?.overflowDirection || ''))
  if (!vertical && !(mainIR.frame.height > MAX_DEVICE_HEIGHT)) return null
  return { height: mainIR.frame.height, fixedHeight: mainIR.sizing?.v !== 'HUG' }
}

// ---- Nội dung riêng từng instance (text override / ẩn-hiện) ----
// Id node bên trong instance có dạng `<instanceId>;<id trong component>` — phần sau là khoá chung giữa mọi instance.
function internalKey(rawId, instanceId) {
  const prefix = `${instanceId};`
  return String(rawId || '').startsWith(prefix) ? String(rawId).slice(prefix.length) : null
}

function indexRawTree(root) {
  const byId = new Map()
  const visit = node => { byId.set(node.id, node); for (const child of node.children || []) visit(child) }
  visit(root)
  return byId
}

function indexInstance(instance) {
  const byKey = new Map()
  const visit = node => {
    const key = internalKey(node.id, instance.id)
    if (key) byKey.set(key, node)
    for (const child of node.children || []) visit(child)
  }
  for (const child of instance.children || []) visit(child)
  return byKey
}

// Slot = chỗ trong component mà ít nhất một instance khác instance gốc: text (label) hoặc ẩn/hiện (bất kỳ view).
function componentSlots(ir, entry) {
  const indexes = entry.instances.map(indexInstance)
  const slots = []
  for (const node of flatten(ir).slice(1)) {
    const key = internalKey(node.figmaId, entry.source.id)
    if (!key) continue
    if (node.kind === 'label' && indexes.some(index => { const raw = index.get(key); return raw?.type === 'TEXT' && displayText(raw) !== node.text })) {
      slots.push({ kind: 'text', key, nodeId: node.id, outlet: node.outlet, param: `${node.outlet}Text`, fallback: node.text })
    }
    if (indexes.some(index => { const raw = index.get(key); return !raw || raw.visible === false })) {
      slots.push({ kind: 'hidden', key, nodeId: node.id, outlet: node.outlet, param: `${node.outlet}Hidden`, fallback: false })
    }
  }
  return slots
}

function annotateInstanceOverrides(root, rawById, slotsByClass) {
  for (const node of flatten(root)) {
    const slots = node.kind === 'component' ? slotsByClass.get(node.className) : null
    const raw = rawById.get(node.figmaId)
    if (!slots?.length || !raw) continue
    const index = indexInstance(raw)
    node.overrides = slots.map(slot => {
      const target = index.get(slot.key)
      const value = slot.kind === 'text' ? (target?.type === 'TEXT' ? displayText(target) : slot.fallback) : (!target || target.visible === false)
      return { slot, value }
    })
  }
}

// Label cần NSAttributedString khi có: đoạn khác kiểu, letter spacing, line height (nhiều dòng) hoặc gạch chân/ngang.
function needsAttributedText(node) {
  const { style } = node
  return Boolean(node.textRuns || style.letterSpacing || style.textDecoration || (style.lineHeight > 0 && style.numberOfLines !== 1))
}

const DECORATION_ATTRIBUTE = { UNDERLINE: '.underlineStyle', STRIKETHROUGH: '.strikethroughStyle' }

// Thuộc tính không gắn (font/màu gốc) thì UILabel dùng font/textColor của chính nó. Bọc `do { }` để biến cục bộ tên cố
// định: không trùng giữa các label, không vượt identifier_name (40 ký tự) như khi ghép outlet dài + hậu tố.
function attributedTextLines(node, targetRef, colorRegistry, hint) {
  const { style } = node
  const label = targetRef === 'self' ? 'self' : targetRef
  const lines = ['        do {', `            let attributed = NSMutableAttributedString(string: ${swiftString(node.text)})`]
  const all = 'NSRange(location: 0, length: attributed.length)'
  const add = (name, value, range) => lines.push('            attributed.addAttribute(', `                ${name},`, `                value: ${value},`, `                range: ${range}`, '            )')
  if (style.lineHeight > 0 && style.numberOfLines !== 1) {
    // Paragraph style ghi đè textAlignment/lineBreakMode của label → đặt lại cho khớp. UIKit dồn khoảng dư của line
    // height lên trên glyph; baselineOffset (lineHeight - font.lineHeight) / 4 đưa chữ về giữa dòng như Figma.
    lines.push(
      '            let paragraph = NSMutableParagraphStyle()',
      `            paragraph.minimumLineHeight = ${formatNumber(style.lineHeight)}`,
      `            paragraph.maximumLineHeight = ${formatNumber(style.lineHeight)}`,
      `            paragraph.alignment = .${swiftTextAlignment(style.textAlign)}`
    )
    add('.paragraphStyle', 'paragraph', all)
    add('.baselineOffset', `(${formatNumber(style.lineHeight)} - (${label}.font?.lineHeight ?? ${formatNumber(style.lineHeight)})) / 4`, all)
  }
  if (style.letterSpacing) add('.kern', formatNumber(style.letterSpacing), all)
  if (style.textDecoration) add(DECORATION_ATTRIBUTE[style.textDecoration], 'NSUnderlineStyle.single.rawValue', all)
  for (const run of node.textRuns || []) {
    const range = `NSRange(location: ${run.start}, length: ${run.end - run.start})`
    if (run.fontWeight !== style.fontWeight) add('.font', swiftFontExpression({ ...style, fontWeight: run.fontWeight }).replace(/\n\s*/, ''), range)
    if (run.color && run.color !== style.textColor) add('.foregroundColor', `${namedColor(colorRegistry, run.color, `${hint}Run`)} ?? .label`, range)
    if (run.decoration !== style.textDecoration) {
      // Đoạn bỏ gạch (decoration null trong khi label có gạch) → gán 0 cho đúng attribute của label.
      const attribute = DECORATION_ATTRIBUTE[run.decoration || style.textDecoration]
      add(attribute, run.decoration ? 'NSUnderlineStyle.single.rawValue' : '0', range)
    }
  }
  lines.push(`            ${targetRef === 'self' ? '' : `${targetRef}.`}attributedText = attributed`, '        }')
  return lines
}

function gradientLines(node, targetRef, hint, colorRegistry) {
  const { gradient, radius } = node.style
  const colors = gradient.stops.map((stop, index) => `                ${namedColor(colorRegistry, stop.rgba, `${hint}Gradient`)}${index < gradient.stops.length - 1 ? ',' : ''}`)
  const lines = [
    '        do {',
    '            let gradientView = GradientLayerView()',
    '            gradientView.gradient.colors = [',
    ...colors,
    '            ].compactMap { $0?.cgColor }',
    `            gradientView.gradient.locations = [${gradient.stops.map(stop => formatNumber(stop.position)).join(', ')}]`,
    `            gradientView.gradient.startPoint = CGPoint(x: ${formatNumber(gradient.start.x)}, y: ${formatNumber(gradient.start.y)})`,
    `            gradientView.gradient.endPoint = CGPoint(x: ${formatNumber(gradient.end.x)}, y: ${formatNumber(gradient.end.y)})`
  ]
  if (gradient.type === 'radial') lines.push('            gradientView.gradient.type = .radial')
  // .conic (iOS 12+): startPoint là tâm, hướng startPoint → endPoint là góc bắt đầu — khớp 2 handle đầu của Figma.
  if (gradient.type === 'angular') lines.push('            gradientView.gradient.type = .conic')
  if (radius > 0) lines.push(`            gradientView.layer.cornerRadius = ${formatNumber(radius)}`)
  if (radius > 0 && node.style.cornerRadii) lines.push(...maskedCornersLines('gradientView.', node.style.cornerRadii, '            '))
  lines.push(`            gradientView.install(in: ${targetRef === 'self' ? 'self' : targetRef})`, '        }')
  return lines
}

// View nền gradient dùng layerClass = CAGradientLayer nên tự co giãn theo Auto Layout (không cần layoutSubviews).
// `private` ở phạm vi file → mỗi file Swift sinh ra tự chứa, không trùng tên giữa các file.
const GRADIENT_HELPER = `
private final class GradientLayerView: UIView {
    override static var layerClass: AnyClass { CAGradientLayer.self }

    var gradient: CAGradientLayer {
        (layer as? CAGradientLayer) ?? CAGradientLayer()
    }

    func install(in host: UIView) {
        isUserInteractionEnabled = false
        layer.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(self, at: 0)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
}
`

function hasUnevenRadii(style) {
  return Boolean(style.cornerRadii) && new Set(style.cornerRadii.filter(value => value > 0)).size > 1
}

function cornerShapeLines(node, targetRef, hint, colorRegistry) {
  const { style } = node
  const lines = ['        do {', `            let shapeView = CornerRadiiShapeView(radii: [${style.cornerRadii.map(formatNumber).join(', ')}])`]
  if (style.background) lines.push(`            shapeView.fillColor = ${namedColor(colorRegistry, style.background, `${hint}Background`)}`)
  if (style.borderColor && style.borderWidth > 0) {
    lines.push(`            shapeView.strokeColor = ${namedColor(colorRegistry, style.borderColor, `${hint}Border`)}`)
    lines.push(`            shapeView.lineWidth = ${formatNumber(style.borderWidth)}`)
  }
  if (style.clipsContent) lines.push('            shapeView.clipsHost = true')
  lines.push(`            shapeView.install(in: ${targetRef === 'self' ? 'self' : targetRef})`, '        }')
  return lines
}

// Nền/viền theo 4 bán kính khác nhau: layer của chính view helper là CAShapeLayer, path cập nhật trong layoutSubviews
// (helper ghim 4 cạnh host nên đổi kích thước host là tự vẽ lại). Không mask host — con tràn góc vẫn hiện — trừ khi
// Figma bật clipsContent (clipsHost).
const CORNER_RADII_HELPER = `
private final class CornerRadiiShapeView: UIView {
    /// Thứ tự như Figma: trên-trái, trên-phải, dưới-phải, dưới-trái.
    private let radii: [CGFloat]
    var fillColor: UIColor?
    var strokeColor: UIColor?
    var lineWidth: CGFloat = 0
    var clipsHost = false

    override static var layerClass: AnyClass { CAShapeLayer.self }

    init(radii: [CGFloat]) {
        self.radii = radii
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) {
        radii = [0, 0, 0, 0]
        super.init(coder: coder)
    }

    func install(in host: UIView) {
        isUserInteractionEnabled = false
        backgroundColor = .clear
        host.backgroundColor = .clear
        translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(self, at: 0)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let path = cornerPath(in: bounds)
        if let shape = layer as? CAShapeLayer {
            shape.path = path
            shape.fillColor = fillColor?.cgColor
            shape.strokeColor = strokeColor?.cgColor
            shape.lineWidth = lineWidth
        }
        guard clipsHost, let host = superview else { return }
        let mask = (host.layer.mask as? CAShapeLayer) ?? CAShapeLayer()
        mask.path = path
        host.layer.mask = mask
    }

    private func cornerPath(in rect: CGRect) -> CGPath {
        let limit = min(rect.width, rect.height) / 2
        let corners = [
            CGPoint(x: rect.minX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.maxY),
            CGPoint(x: rect.minX, y: rect.maxY)
        ]
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.minX + min(radii[0], limit), y: rect.minY))
        for index in 1...4 {
            let corner = index % 4
            let radius = min(radii[corner], limit)
            path.addArc(tangent1End: corners[corner], tangent2End: corners[(corner + 1) % 4], radius: radius)
        }
        path.closeSubpath()
        return path
    }
}
`

// Figma blur radius liên tục, UIKit chỉ có vài material — chọn mức gần nhất (iOS 13+).
export function blurMaterial(radius) {
  if (radius <= 10) return 'systemUltraThinMaterial'
  if (radius <= 20) return 'systemThinMaterial'
  if (radius <= 40) return 'systemMaterial'
  return 'systemThickMaterial'
}

function backgroundBlurLines(node, targetRef) {
  const { style } = node
  const lines = ['        do {', `            let blurView = BlurBackgroundView(effect: UIBlurEffect(style: .${blurMaterial(style.backgroundBlur)}))`]
  if (style.radius > 0) lines.push(`            blurView.layer.cornerRadius = ${formatNumber(style.radius)}`)
  lines.push(`            blurView.install(in: ${targetRef === 'self' ? 'self' : targetRef})`, '        }')
  return lines
}

function innerShadowLines(node, targetRef, hint, colorRegistry) {
  const { innerShadow, radius } = node.style
  const lines = [
    '        do {',
    '            let innerShadow = InnerShadowView()',
    `            innerShadow.shadowColor = ${namedColor(colorRegistry, innerShadow.color || 'rgba(0, 0, 0, 0.25)', `${hint}InnerShadow`)}`,
    `            innerShadow.shadowOffset = CGSize(width: ${formatNumber(innerShadow.x)}, height: ${formatNumber(innerShadow.y)})`,
    `            innerShadow.shadowBlur = ${formatNumber(innerShadow.blur)}`
  ]
  if (radius > 0) lines.push(`            innerShadow.cornerRadius = ${formatNumber(radius)}`)
  lines.push(`            innerShadow.install(in: ${targetRef === 'self' ? 'self' : targetRef})`, '        }')
  return lines
}

// Fill của host chuyển vào contentView của blur: Figma vẽ fill (thường bán trong suốt) phía trên lớp blur nền.
const BLUR_BACKGROUND_HELPER = `
private final class BlurBackgroundView: UIVisualEffectView {
    func install(in host: UIView) {
        isUserInteractionEnabled = false
        clipsToBounds = true
        contentView.backgroundColor = host.backgroundColor
        host.backgroundColor = .clear
        translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(self, at: 0)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
}
`

// Inner shadow: CAShapeLayer hình "khung" (hình chữ nhật lớn trừ hình view, even-odd) nằm ngoài bounds nên bị clip,
// chỉ còn bóng của khung đổ vào trong — đúng kiểu inner shadow của Figma, không cần vẽ ảnh.
const INNER_SHADOW_HELPER = `
private final class InnerShadowView: UIView {
    var shadowColor: UIColor?
    var shadowOffset: CGSize = .zero
    var shadowBlur: CGFloat = 0
    var cornerRadius: CGFloat = 0
    private let shadowLayer = CAShapeLayer()

    func install(in host: UIView) {
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.addSublayer(shadowLayer)
        translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(self, at: 0)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = cornerRadius
        let spread = shadowBlur * 2 + max(abs(shadowOffset.width), abs(shadowOffset.height)) + 1
        let path = UIBezierPath(rect: bounds.insetBy(dx: -spread, dy: -spread))
        path.append(UIBezierPath(roundedRect: bounds, cornerRadius: cornerRadius))
        shadowLayer.frame = bounds
        shadowLayer.path = path.cgPath
        shadowLayer.fillRule = .evenOdd
        shadowLayer.fillColor = UIColor.black.cgColor
        shadowLayer.shadowColor = shadowColor?.cgColor
        shadowLayer.shadowOffset = shadowOffset
        shadowLayer.shadowRadius = shadowBlur / 2
        shadowLayer.shadowOpacity = 1
    }
}
`

export function backgroundAssetName(node) {
  return `${node.outlet}Background`
}

const IMAGE_CONTENT_MODE = { FILL: '.scaleAspectFill', FIT: '.scaleAspectFit', STRETCH: '.scaleToFill', TILE: '.scaleToFill' }

// Ảnh nền (image fill của container) nằm dưới mọi view con, co giãn theo host bằng Auto Layout.
function backgroundImageLines(node, targetRef) {
  const { scaleMode } = node.style.backgroundImage
  return [
    '        do {',
    '            let backgroundView = BackgroundImageView()',
    `            backgroundView.image = UIImage(named: ${swiftString(backgroundAssetName(node))})`,
    `            backgroundView.contentMode = ${IMAGE_CONTENT_MODE[scaleMode] || '.scaleAspectFill'}`,
    `            backgroundView.install(in: ${targetRef === 'self' ? 'self' : targetRef})`,
    '        }'
  ]
}

// clipsToBounds trên chính ảnh nền: scaleAspectFill tràn khung sẽ bị cắt mà không phải clip cả host (con tràn góc).
const BACKGROUND_IMAGE_HELPER = `
private final class BackgroundImageView: UIImageView {
    func install(in host: UIView) {
        clipsToBounds = true
        isAccessibilityElement = false
        isUserInteractionEnabled = false
        translatesAutoresizingMaskIntoConstraints = false
        host.insertSubview(self, at: 0)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            topAnchor.constraint(equalTo: host.topAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
    }
}
`

function withGradientHelper(swift) {
  let out = swift
  if (out.includes('GradientLayerView()')) out += GRADIENT_HELPER
  if (out.includes('BackgroundImageView(')) out += BACKGROUND_IMAGE_HELPER
  if (out.includes('CornerRadiiShapeView(')) out += CORNER_RADII_HELPER
  if (out.includes('BlurBackgroundView(')) out += BLUR_BACKGROUND_HELPER
  if (out.includes('InnerShadowView()')) out += INNER_SHADOW_HELPER
  return withLengthGuards(out)
}

// Màn hình lớn (vd "Bán gói ngày") sinh file/hàm dài vượt ngưỡng mặc định của SwiftLint (warning: hàm 50, type 250,
// file 400 dòng; --strict coi warning là lỗi). Code sinh ra không nên bị tách tay, nên chỉ tắt đúng rule tại đúng chỗ
// vượt ngưỡng. Phải đếm chính xác như SwiftLint (bỏ dòng trống/comment) vì disable thừa lại bị superfluous_disable_command.
const LENGTH_LIMITS = { function: 50, type: 250, file: 400 }

function withLengthGuards(swift) {
  const lines = swift.split('\n')
  const bodyLength = (start, indent) => {
    let count = 0
    for (let index = start + 1; index < lines.length; index++) {
      if (lines[index] === `${indent}}`) return count
      const trimmed = lines[index].trim()
      if (trimmed && !trimmed.startsWith('//')) count++
    }
    return count
  }
  // `disable:this` ở cuối dòng khai báo (nơi SwiftLint báo lỗi): chèn dòng `disable:next` phía trên sẽ chen giữa
  // doc comment (///) và khai báo → orphaned_doc_comment.
  const out = lines.map((line, index) => {
    const func = line.match(/^(\s*)(?:(?:private|fileprivate|override|static|final|@objc)\s+)*func\s.*\{$/)
    const type = line.match(/^(\s*)(?:(?:private|fileprivate|final)\s+)*(?:class|struct|enum)\s.*\{$/)
    if (func && bodyLength(index, func[1]) > LENGTH_LIMITS.function) return `${line} // swiftlint:disable:this function_body_length`
    if (type && bodyLength(index, type[1]) > LENGTH_LIMITS.type) return `${line} // swiftlint:disable:this type_body_length`
    return line
  })
  const lineCount = swift.endsWith('\n') ? out.length - 1 : out.length
  // file_length được phép disable toàn file (nằm trong allowed_rules mặc định của blanket_disable_command).
  return lineCount > LENGTH_LIMITS.file ? `// swiftlint:disable file_length\n${out.join('\n')}` : out.join('\n')
}

export function isButtonName(name) {
  return /(^|[^a-z])(button|btn|cta|nut)([^a-z]|$)/.test(foldDiacritics(String(name || '')).toLowerCase())
}

// Component nút: UIControl (target-action, highlight, trait .button) thay UIView — giữ nguyên cây view/layout.
function asButtonControl(swift, ir) {
  if (!ir.meta?.isButton) return swift
  const texts = flatten(ir).filter(node => node.kind === 'label' && node.text).map(node => node.text)
  const label = texts.length ? `\n        accessibilityLabel = ${swiftString(texts.join(', '))}` : ''
  return swift
    .replace(/^final class (\w+): UIView \{$/m, 'final class $1: UIControl {')
    .replace('    private func commonInit() {', `    override var isHighlighted: Bool {\n        didSet { alpha = isHighlighted ? 0.6 : 1 }\n    }\n\n    private func commonInit() {`)
    // Con không nhận chạm → UIControl nhận trọn touch (highlight + .touchUpInside) dù bấm trúng label/icon.
    .replace('        applyGeneratedStyle()\n    }', `        applyGeneratedStyle()\n        subviews.forEach { $0.isUserInteractionEnabled = false }\n        isAccessibilityElement = true\n        accessibilityTraits = .button${label}\n    }`)
}

// View chứa instance nút → addTarget + closure `onXxxTap` để màn hình/VC gắn hành động mà không cần outlet public.
function withButtonActions(swift, ir, buttonClasses) {
  const buttons = flatten(ir).slice(1).filter(node => node.kind === 'component' && buttonClasses.has(node.className))
  if (!buttons.length) return swift
  const used = new Set()
  const members = []
  const targets = []
  for (const node of buttons) {
    // handle + ≤31 + Tap ≤ 40 ký tự (identifier_name áp dụng cả tên hàm).
    let base = node.outlet.charAt(0).toUpperCase() + node.outlet.slice(1, 31)
    for (let n = 2; used.has(base); n++) base = `${base.slice(0, 30)}${n}`
    used.add(base)
    members.push(
      `    /// Bấm "${humanizeLayerName(node.name).replace(/"/g, '')}".`,
      `    var on${base}Tap: (() -> Void)?`,
      '',
      `    @objc private func handle${base}Tap() {`,
      `        on${base}Tap?()`,
      '    }',
      ''
    )
    const single = `        ${node.outlet}.addTarget(self, action: #selector(handle${base}Tap), for: .touchUpInside)`
    targets.push(...(single.length <= 120 ? [single] : [`        ${node.outlet}.addTarget(`, '            self,', `            action: #selector(handle${base}Tap),`, '            for: .touchUpInside', '        )']))
  }
  return swift
    .replace('    override init(frame: CGRect) {', `${members.join('\n')}\n    override init(frame: CGRect) {`)
    .replace('    private func applyGeneratedStyle() {\n', `    private func applyGeneratedStyle() {\n${targets.join('\n')}\n`)
}

// Thêm `struct Content` + `configure(with:)` vào class component. Dùng struct thay vì nhiều tham số để không
// vượt function_parameter_count (SwiftLint) khi component có nhiều text/ẩn-hiện khác nhau giữa các instance.
function withConfigure(swift, slots) {
  if (!slots?.length) return swift
  const fields = slots.map(slot => `        let ${slot.param}: ${slot.kind === 'text' ? 'String' : 'Bool'}`)
  const assigns = slots.map(slot => slot.kind === 'text'
    ? `        ${slot.outlet}.text = content.${slot.param}`
    : `        ${slot.outlet}.isHidden = content.${slot.param}`)
  const block = `\n    struct Content {\n${fields.join('\n')}\n    }\n\n    func configure(with content: Content) {\n${assigns.join('\n')}\n    }\n}\n`
  return swift.replace(/\n}\n$/, `\n${block}`)
}

// Nhiều instance cùng component có nội dung riêng → gom thành mảng dữ liệu + vòng lặp thay cho N lệnh configure rời:
// chỗ thay bằng dữ liệu thật (API/ViewModel) chỉ còn một mảng. Chỉ đổi phần dữ liệu, cây view/constraint giữ nguyên
// (XIB không có vòng lặp).
export function repeatedInstanceGroups(root) {
  const byClass = new Map()
  for (const node of flatten(root).slice(1)) {
    if (node.kind !== 'component' || !node.overrides?.length) continue
    if (!byClass.has(node.className)) byClass.set(node.className, [])
    byClass.get(node.className).push(node)
  }
  return [...byClass.entries()].filter(([, nodes]) => nodes.length > 1).map(([className, nodes]) => ({
    className, nodes, name: `${lowerFirst(className.replace(/View$/, '') || className).slice(0, 35)}Items`
  }))
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

function instanceGroupLines({ className, nodes, name }) {
  const items = nodes.flatMap((node, index) => [
    '            .init(',
    ...node.overrides.map(({ slot, value }, argIndex) => {
      const line = `                ${slot.param}: ${slot.kind === 'text' ? swiftString(value) : String(value)}${argIndex < node.overrides.length - 1 ? ',' : ''}`
      return line.length > 120 ? `                // swiftlint:disable:next line_length\n${line}` : line
    }),
    `            )${index < nodes.length - 1 ? ',' : ''}`
  ])
  // Kiểu tường minh: outlet XIB là IUO (`View!`), để suy luận thì mảng thành [View?] và không gọi được configure.
  const viewsName = name.replace(/Items$/, 'Views')
  const viewsLine = `        let ${viewsName}: [${className}] = [${nodes.map(node => node.outlet).join(', ')}]`
  return [
    `        let ${name}: [${className}.Content] = [`,
    ...items,
    '        ]',
    ...(viewsLine.length <= 120 ? [viewsLine] : [`        let ${viewsName}: [${className}] = [`, ...nodes.map((node, index) => `            ${node.outlet}${index < nodes.length - 1 ? ',' : ''}`), '        ]']),
    `        for (view, content) in zip(${viewsName}, ${name}) {`,
    '            view.configure(with: content)',
    '        }'
  ]
}

function configureCallLines(target, overrides) {
  const args = overrides.map(({ slot, value }, index) => `            ${slot.param}: ${slot.kind === 'text' ? swiftString(value) : String(value)}${index < overrides.length - 1 ? ',' : ''}`)
  return [`        ${target}configure(with: .init(`, ...args, '        ))']
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

  const rasterized = node.id !== options.skipComponentForNodeId && parentNode !== null && isRasterCandidate(node)
  const isReusableInstance = !rasterized && node.type === 'INSTANCE' && node.componentId && componentMap.has(node.componentId) && node.id !== options.skipComponentForNodeId
  const reusable = isReusableInstance ? componentMap.get(node.componentId) : null
  const renderableChildren = rasterized ? [] : visibleRenderableChildren(node)
  const kind = rasterized ? 'image' : reusable ? 'component' : inferKind(node, renderableChildren)

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
    // Ảnh render từ Figma có kích thước cố định — HUG (tự co theo con) không còn nghĩa khi con đã bị gộp vào ảnh.
    sizing: rasterized ? hugToFixed(sizingOf(node, parentNode)) : sizingOf(node, parentNode),
    priorities: {},
    constraints: [],
    stack: null,
    text: node.type === 'TEXT' ? displayText(node) : '',
    textRuns: node.type === 'TEXT' ? textRunsOf(node) : null,
    style: rasterized ? rasterStyle(extractStyle(node)) : extractStyle(node),
    layout: extractLayout(node),
    meta: {
      hasImageFill: hasImageFill(node),
      preservesChildrenOverImageFill: hasImageFill(node) && renderableChildren.length > 0,
      layoutPositioning: node.layoutPositioning || 'AUTO',
      wraps: node.layoutWrap === 'WRAP',
      rasterized
    },
    // Instance tái sử dụng: ghi chú nằm trong file component (cùng dữ liệu) — không lặp lại ở màn hình cha.
    todos: reusable ? [] : todosOf(node, parentNode, rasterized),
    children: []
  }

  // Container có image fill + con: ảnh gốc (imageRef) thành asset nền riêng, con vẫn giữ nguyên phía trên.
  if (ir.meta.preservesChildrenOverImageFill && !rasterized) {
    const paint = (node.fills || []).find(item => item?.visible !== false && item?.type === 'IMAGE' && item.imageRef)
    if (paint) ir.style.backgroundImage = { imageRef: paint.imageRef, scaleMode: paint.scaleMode || 'FILL' }
  }

  if (!reusable) {
    ir.children = renderableChildren.map(child => buildIR(child, node, componentMap, options))
    layoutChildren(node, ir, renderableChildren)
  }
  return ir
}

// Fill/stroke/shadow của vector đã nằm sẵn trong ảnh export — giữ lại sẽ vẽ thêm một ô màu vuông sau icon.
function rasterStyle(style) {
  return { ...style, background: null, gradient: null, borderColor: null, borderWidth: 0, shadow: null }
}

// Những gì compiler chỉ làm xấp xỉ/bỏ qua → ghi chú "// TODO:" ngay tại dòng code của view đó (và gom vào TODO.md),
// để dev biết chỗ nào cần chỉnh tay thay vì phải tự so từng layer với Figma. Câu ngắn để comment không vượt line_length.
export function todosOf(node, parentNode = null, rasterized = false) {
  const todos = []
  const visible = item => item && item.visible !== false
  const fills = (node.fills || []).filter(visible)
  for (const paint of fills) {
    if (paint.type === 'GRADIENT_DIAMOND') todos.push('gradient diamond chưa hỗ trợ; export nền thành ảnh hoặc vẽ tay.')
  }
  if (!rasterized && node.type !== 'TEXT') {
    const gradient = fills.find(paint => GRADIENT_TYPES[paint.type])
    if (gradient && fills.some(paint => paint.type === 'SOLID')) todos.push('nhiều lớp fill (solid + gradient); code chỉ giữ lớp solid.')
    else if (gradient?.type === 'GRADIENT_RADIAL') todos.push('radial gradient Figma là elip; SwiftUI/CAGradientLayer vẽ tròn — so lại với thiết kế.')
    else if (gradient && !gradient.gradientHandlePositions) todos.push('gradient thiếu handle; đang giả định hướng trên → dưới.')
  }
  const effects = (node.effects || []).filter(visible)
  // Drop/inner shadow và background blur đã sinh code; layer blur chỉ SwiftUI có (.blur) — UIKit không có API công khai.
  const handled = new Set(['DROP_SHADOW', 'INNER_SHADOW', 'BACKGROUND_BLUR'])
  const unsupported = [...new Set(effects.filter(item => !handled.has(item.type) && item.type !== 'LAYER_BLUR').map(item => item.type.toLowerCase().replace(/_/g, ' ')))]
  if (unsupported.length) todos.push(`effect ${unsupported.join(', ')} chưa được sinh code.`)
  if (effects.some(item => item.type === 'LAYER_BLUR')) todos.push('layer blur: UIKit không có API công khai để blur nội dung view (SwiftUI đã dùng .blur).')
  if (effects.filter(item => item.type === 'INNER_SHADOW').length > 1) todos.push('nhiều inner shadow; code chỉ giữ inner shadow đầu tiên.')
  if (effects.filter(item => item.type === 'DROP_SHADOW').length > 1) todos.push('nhiều drop shadow; code chỉ giữ shadow đầu tiên.')
  if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) todos.push(`blend mode ${node.blendMode.toLowerCase()} chưa hỗ trợ.`)
  // maskedCorners chỉ bật/tắt góc với cùng một bán kính; bán kính khác nhau thật sự thì UIKit cần mask path riêng.
  const radii = mixedCornerRadii(node)
  if (radii && new Set(radii.filter(value => value > 0)).size > 1 && fills.some(paint => GRADIENT_TYPES[paint.type])) {
    todos.push(`gradient + bo góc khác bán kính (${radii.join('/')}); UIKit đang dùng góc lớn nhất (SwiftUI đã vẽ đúng).`)
  }
  if (!rasterized && isAutoLayout(node)) {
    if (node.layoutWrap === 'WRAP') todos.push('Auto Layout wrap; UIStackView không xuống dòng — cân nhắc UICollectionView.')
    if ((node.itemSpacing || 0) < 0) todos.push(`spacing âm (${round(node.itemSpacing)}); UIStackView không chồng lấn — kiểm tra lại layout.`)
  }
  if (!rasterized && node.type !== 'TEXT' && Math.abs(node.rotation || 0) > 0.5) todos.push('node bị xoay; transform xoay chưa được sinh code.')
  if (node.type === 'TEXT') {
    const family = node.style?.fontFamily
    if (family && !isSystemFontFamily(family)) todos.push(`font "${family}" cần bundle vào app (UIAppFonts trong Info.plist).`)
  }
  if (parentNode && node.layoutPositioning === 'ABSOLUTE' && isAutoLayout(parentNode)) {
    const own = node.absoluteBoundingBox
    const box = parentNode.absoluteBoundingBox
    const overflows = own && box && (own.x < box.x || own.y < box.y || own.x + own.width > box.x + box.width || own.y + own.height > box.y + box.height)
    if (overflows) todos.push('view absolute tràn ra ngoài cha; kiểm tra clipsToBounds và thứ tự z của cha.')
  }
  return todos
}

// TODO.md đi kèm export: gom mọi ghi chú theo từng file/view để dev có checklist việc cần làm tay.
export function todoMarkdown(sections) {
  const filled = sections.filter(section => section.items.length)
  if (!filled.length) return ''
  const blocks = filled.map(({ title, items }) => `## ${title}\n\n${items.map(({ outlet, name, todo }) => `- [ ] \`${outlet}\` (${name}): ${todo}`).join('\n')}`)
  return `# TODO\n\nNhững chỗ UIKitForge chỉ sinh xấp xỉ hoặc chưa hỗ trợ. Mỗi mục cũng có \`// TODO:\` ngay tại dòng code tương ứng.\n\n${blocks.join('\n\n')}\n`
}

export function collectTodoItems(root) {
  return flatten(root).flatMap(node => (node.todos || []).map(todo => ({ outlet: node.outlet, name: node.name, todo })))
}

function visibleRenderableChildren(node) {
  return (node.children || []).filter(child => child.visible !== false && isRenderable(child))
}

function isRenderable(node) {
  return node.type === 'TEXT' || VIEW_TYPES.has(node.type) || isUnknownContainer(node)
}

// Figma thêm node type mới theo thời gian (SLOT từng bị bỏ qua như vậy) — node lạ nhưng có con vẫn là
// container, loại nó đi sẽ mất im lặng cả nhánh con (label, component...). Dựng thành UIView thường + cảnh báo.
function isUnknownContainer(node) {
  return node.type !== 'TEXT' && !VIEW_TYPES.has(node.type) && (node.children || []).length > 0
}

function collectUnknownContainerTypes(node, types = new Set()) {
  for (const child of node.children || []) {
    if (child.visible === false) continue
    if (isUnknownContainer(child)) types.add(child.type)
    collectUnknownContainerTypes(child, types)
  }
  return types
}

// Đoạn chữ khác kiểu (vd "Số **0123 456 789** của bạn…"). REST: characterStyleOverrides[i] trỏ vào
// styleOverrideTable (0 = kiểu gốc, số 0 ở cuối có thể bị lược). Chỉ lấy đoạn khác font-weight gốc.
// Figma lưu chữ gốc và hiển thị theo textCase — áp luôn vào chuỗi sinh ra để code/preview khớp thiết kế.
export function displayText(node) {
  const text = String(node.characters || '')
  switch (node.style?.textCase) {
    case 'UPPER': return text.toUpperCase()
    case 'LOWER': return text.toLowerCase()
    case 'TITLE': return text.replace(/(^|\s)(\S)/g, (_, space, char) => `${space}${char.toUpperCase()}`)
    default: return text
  }
}

function decorationOf(value) {
  return value === 'UNDERLINE' || value === 'STRIKETHROUGH' ? value : null
}

// Đoạn chữ có kiểu khác phần còn lại (weight, màu, gạch chân/ngang) — REST: characterStyleOverrides + styleOverrideTable.
// Chỉ trả runs khi có đoạn khác kiểu gốc; màu/decoration gốc do label tự mang nên run chỉ ghi phần khác.
export function textRunsOf(node) {
  const overrides = node.characterStyleOverrides || []
  const table = node.styleOverrideTable || {}
  const text = displayText(node)
  const base = {
    fontWeight: normalizeFontWeight(node.style?.fontWeight || 400),
    color: paintToRgba(firstVisibleSolidPaint(node.fills || [])),
    decoration: decorationOf(node.style?.textDecoration)
  }
  const styleAt = index => {
    const override = table[overrides[index]] || {}
    return {
      fontWeight: override.fontWeight ? normalizeFontWeight(override.fontWeight) : base.fontWeight,
      color: override.fills ? paintToRgba(firstVisibleSolidPaint(override.fills)) || base.color : base.color,
      decoration: 'textDecoration' in override ? decorationOf(override.textDecoration) : base.decoration
    }
  }
  const same = (a, b) => a.fontWeight === b.fontWeight && a.color === b.color && a.decoration === b.decoration
  const runs = []
  for (let index = 0; index < text.length; index++) {
    const style = styleAt(index)
    const last = runs[runs.length - 1]
    if (last && same(last, style)) last.end = index + 1
    else runs.push({ start: index, end: index + 1, ...style })
  }
  if (!runs.some(run => !same(run, base))) return null
  // Giữ chuỗi gốc của từng đoạn để nơi dùng nhận ra text đã bị override (offset không còn đúng).
  return runs.map(run => ({ ...run, text: text.slice(run.start, run.end) }))
}

function hugToFixed(sizing) {
  return { h: sizing.h === 'HUG' ? 'FIXED' : sizing.h, v: sizing.v === 'HUG' ? 'FIXED' : sizing.v }
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

function shadowOf(effect) {
  if (!effect) return null
  return {
    x: round(effect.offset?.x || 0), y: round(effect.offset?.y || 0),
    blur: round(effect.radius || 0), spread: round(effect.spread || 0),
    color: paintColorToRgba(effect.color)
  }
}

function blurRadiusOf(node, type) {
  const effect = (node.effects || []).find(item => item?.visible !== false && item?.type === type)
  return effect ? round(effect.radius || 0) : 0
}

export function mixedCornerRadii(node) {
  const radii = Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii.map(value => round(value || 0)) : null
  return radii?.length === 4 && new Set(radii).size > 1 ? radii : null
}

function extractStyle(node) {
  const fill = firstVisibleSolidPaint(node.fills || [])
  const stroke = firstVisibleSolidPaint(node.strokes || [])
  const effect = (node.effects || []).find(item => item?.visible !== false && item?.type === 'DROP_SHADOW')
  const textStyle = node.style || {}
  const mixedRadii = mixedCornerRadii(node)
  const radius = mixedRadii ? Math.max(...mixedRadii)
    : Number.isFinite(node.cornerRadius) ? node.cornerRadius
      : Array.isArray(node.rectangleCornerRadii) ? Math.max(...node.rectangleCornerRadii) : 0

  return {
    // Với TEXT, `fills` của Figma là màu chữ (glyph), không phải nền — lấy làm backgroundColor sẽ ra khối đặc cùng màu chữ.
    background: node.type === 'TEXT' ? null : paintToRgba(fill),
    textColor: node.type === 'TEXT' ? paintToRgba(fill) || 'rgba(0, 0, 0, 1)' : null,
    borderColor: paintToRgba(stroke),
    borderWidth: round(node.strokeWeight || 0),
    radius: round(radius || 0),
    // Chỉ giữ khi 4 góc khác nhau (thứ tự Figma: trên-trái, trên-phải, dưới-phải, dưới-trái); góc đều thì radius là đủ.
    cornerRadii: mixedRadii,
    opacity: node.opacity == null ? 1 : node.opacity,
    fontSize: round(textStyle.fontSize || 14),
    fontFamily: textStyle.fontFamily || 'System',
    fontWeight: normalizeFontWeight(textStyle.fontWeight || 400),
    // Line height "Auto" (INTRINSIC_%) là mặc định của font — chỉ sinh code khi designer đặt giá trị cụ thể.
    lineHeight: textStyle.lineHeightUnit === 'INTRINSIC_%' ? 0 : round(textStyle.lineHeightPx || 0),
    textDecoration: decorationOf(textStyle.textDecoration),
    letterSpacing: round(textStyle.letterSpacing || 0),
    textAlign: String(textStyle.textAlignHorizontal || 'LEFT').toLowerCase(),
    numberOfLines: textStyle.textAutoResize === 'HEIGHT' || textStyle.textAutoResize === 'WIDTH_AND_HEIGHT' ? 0 : 1,
    shadow: effect ? {
      x: round(effect.offset?.x || 0), y: round(effect.offset?.y || 0),
      blur: round(effect.radius || 0), spread: round(effect.spread || 0),
      color: paintColorToRgba(effect.color)
    } : null,
    innerShadow: shadowOf((node.effects || []).find(item => item?.visible !== false && item?.type === 'INNER_SHADOW')),
    backgroundBlur: blurRadiusOf(node, 'BACKGROUND_BLUR'),
    layerBlur: blurRadiusOf(node, 'LAYER_BLUR'),
    // Nền gradient (không có màu đặc) — sinh CAGradientLayer / LinearGradient thay vì bỏ trống nền như trước.
    gradient: node.type === 'TEXT' || fill ? null : gradientOf(node),
    clipsContent: Boolean(node.clipsContent)
  }
}

// Figma gradientHandlePositions nằm trong hệ toạ độ đơn vị của node (0..1, y hướng xuống) — trùng với
// startPoint/endPoint của CAGradientLayer và UnitPoint của SwiftUI. Không có handle thì mặc định trên → dưới.
const GRADIENT_TYPES = { GRADIENT_LINEAR: 'linear', GRADIENT_RADIAL: 'radial', GRADIENT_ANGULAR: 'angular' }

function gradientOf(node) {
  const paint = (node.fills || []).find(item => item?.visible !== false && GRADIENT_TYPES[item?.type])
  if (!paint?.gradientStops?.length) return null
  // Angular: handle 0 là tâm, handle 1 cho hướng bắt đầu — giống radial về vị trí mặc định.
  const radial = paint.type !== 'GRADIENT_LINEAR'
  const [h0, h1] = paint.gradientHandlePositions || []
  const point = (handle, fallback) => handle ? { x: round(handle.x), y: round(handle.y) } : fallback
  const opacity = paint.opacity == null ? 1 : paint.opacity
  return {
    type: GRADIENT_TYPES[paint.type],
    stops: paint.gradientStops.map(stop => ({
      position: round(stop.position),
      rgba: paintColorToRgba({ ...stop.color, a: (stop.color?.a ?? 1) * opacity })
    })),
    start: point(h0, radial ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0 }),
    end: point(h1, radial ? { x: 1, y: 1 } : { x: 0.5, y: 1 }),
    approximated: !paint.gradientHandlePositions
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
    // SPACE_BETWEEN với đúng 1 con FILL: Figma kéo con giãn hết trục chính; .equalSpacing của UIStackView thì không
    // bao giờ kéo giãn (con chỉ rộng theo nội dung) → dùng .fill mới đúng ý thiết kế.
    distribution: spaceBetween && !(arranged.length === 1 && arranged[0].sizing[main] === 'FILL') ? 'equalSpacing' : 'fill',
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
  const grouped = repeatedInstanceGroups(root)
  for (const group of grouped) lines.push(...instanceGroupLines(group))
  const groupedIds = new Set(grouped.flatMap(group => group.nodes.map(node => node.id)))
  for (const [index, node] of flatten(root).entries()) {
    const targetRef = index === 0 ? rootRef : node.outlet
    const target = targetRef === 'self' ? '' : `${targetRef}.` // self ngầm định — tránh redundantSelf của SwiftFormat
    const hint = node.outlet || 'root'
    const style = node.style || {}
    if (includeStatic) lines.push(...todoCommentLines(node, '        '))
    if (index > 0 && node.kind === 'component' && node.overrides?.length && !groupedIds.has(node.id)) lines.push(...configureCallLines(target, node.overrides))
    // Bán kính khác nhau thật sự (không chỉ bật/tắt góc) → nền + viền vẽ bằng CornerRadiiShapeView thay cho
    // backgroundColor/cornerRadius/border của layer; gradient vẫn dùng góc lớn nhất (còn TODO).
    // Helper nền đều chèn ở index 0 → dòng sinh trước nằm trên: inner shadow → nền (shape/gradient/ảnh) → blur.
    if (includeStatic && style.innerShadow && node.kind !== 'image') lines.push(...innerShadowLines(node, targetRef, hint, colorRegistry))
    const shapedCorners = includeStatic && hasUnevenRadii(style) && !style.gradient && node.kind !== 'image'
    if (shapedCorners) lines.push(...cornerShapeLines(node, targetRef, hint, colorRegistry))
    if (includeStatic && style.background && !shapedCorners) lines.push(`        ${target}backgroundColor = ${namedColor(colorRegistry, style.background, `${hint}Background`)}`)
    if (style.radius > 0 && !shapedCorners) {
      lines.push(`        ${target}layer.cornerRadius = ${formatNumber(style.radius)}`)
      if (style.cornerRadii) lines.push(...maskedCornersLines(target, style.cornerRadii))
      // cornerRadius đã bo cả nền/viền mà không cần clip; chỉ clip khi Figma bật clipsContent (hoặc ảnh cần bo),
      // nếu không phần tử tràn góc (nhãn "Hot") sẽ bị cắt như trong preview trước đây.
      if (style.clipsContent || node.kind === 'image') lines.push(`        ${target}layer.masksToBounds = true`)
    }
    if (includeStatic && style.gradient && node.kind !== 'image') lines.push(...gradientLines(node, targetRef, hint, colorRegistry))
    if (includeStatic && style.backgroundImage) lines.push(...backgroundImageLines(node, targetRef))
    if (includeStatic && style.backgroundBlur && node.kind !== 'image') lines.push(...backgroundBlurLines(node, targetRef))
    if (style.borderColor && style.borderWidth > 0 && !shapedCorners) {
      lines.push(`        ${target}layer.borderColor = ${cgColor(namedColor(colorRegistry, style.borderColor, `${hint}Border`))}`)
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
      if (includeStatic && needsAttributedText(node)) lines.push(...attributedTextLines(node, targetRef, colorRegistry, hint))
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
      // Ảnh xuất từ icon/hình vẽ (vector) gần như luôn là trang trí cạnh text → ẩn khỏi VoiceOver thay vì đọc
      // tên layer vô nghĩa ("Frame 2085667765"). Ảnh nội dung (image fill) vẫn giữ nhãn như trước.
      if (node.meta?.rasterized) {
        lines.push(`        ${target}isAccessibilityElement = false`)
      } else {
        lines.push(`        ${target}isAccessibilityElement = true`)
        lines.push(`        ${target}accessibilityLabel = ${swiftString(humanizeLayerName(node.name))}`)
      }
    }
    if (style.shadow) {
      lines.push(`        ${target}layer.shadowColor = ${cgColor(namedColor(colorRegistry, style.shadow.color || 'rgba(0, 0, 0, 0.2)', `${hint}Shadow`))}`)
      lines.push(`        ${target}layer.shadowOpacity = ${formatNumber(alphaFromRgba(style.shadow.color || 'rgba(0,0,0,0.2)'))}`)
      lines.push(`        ${target}layer.shadowOffset = CGSize(width: ${formatNumber(style.shadow.x)}, height: ${formatNumber(style.shadow.y)})`)
      lines.push(`        ${target}layer.shadowRadius = ${formatNumber(style.shadow.blur / 2)}`)
      lines.push(`        ${target}layer.masksToBounds = false`)
    }
  }
  return allowLongLiteralLines(lines).join('\n')
}

// Text/accessibilityLabel lấy nguyên câu từ Figma — không bẻ dòng string literal an toàn được, nên chỉ tắt
// line_length cho đúng dòng đó. Ngưỡng 120 khớp .swiftlint.yml đi kèm (tránh superfluous_disable_command).
function allowLongLiteralLines(lines) {
  return lines.flatMap(line => line.includes('\n') || line.length <= 120
    ? [line]
    : [`${line.match(/^\s*/)[0]}// swiftlint:disable:next line_length`, line])
}

// Figma ghi font hệ thống Apple bằng tên hiển thị ("SF Pro Display/Text", "SF Compact") — không phải tên
// đăng ký trên iOS, nên UIFont(name:) luôn nil và còn bỏ qua weight. Coi là font hệ thống.
const CA_CORNERS = ['.layerMinXMinYCorner', '.layerMaxXMinYCorner', '.layerMaxXMaxYCorner', '.layerMinXMaxYCorner']

// Góc bằng 0 trong Figma → tắt góc đó bằng maskedCorners (iOS 11+), không cần mask layer/bezier path.
function maskedCornersLines(target, radii, pad = '        ') {
  const corners = CA_CORNERS.filter((_, index) => radii[index] > 0)
  if (corners.length === 4) return []
  const single = `${pad}${target}layer.maskedCorners = [${corners.join(', ')}]`
  if (single.length <= 120) return [single]
  const items = corners.map((corner, index) => `${pad}    ${corner}${index < corners.length - 1 ? ',' : ''}`)
  return [`${pad}${target}layer.maskedCorners = [`, ...items, `${pad}]`]
}

// Tách comment dài thành nhiều dòng để không vượt line_length 120 của SwiftLint (comment cũng bị tính).
export function todoCommentLines(node, indent, width = 110) {
  return (node.todos || []).flatMap(todo => {
    const lines = []
    let current = `${indent}// TODO: [${node.outlet}]`
    for (const word of todo.split(' ')) {
      if (current.length + word.length + 1 > width) {
        lines.push(current)
        current = `${indent}//   ${word}`
      } else current += ` ${word}`
    }
    return [...lines, current]
  })
}

export function isSystemFontFamily(family) {
  return !family || /^(system|\.?sf pro|sf compact|\.?sf ui|san francisco)/i.test(String(family).trim())
}

function swiftFontExpression(style) {
  const weight = swiftFontWeight(style.fontWeight)
  const base = style.fontFamily && !isSystemFontFamily(style.fontFamily)
    ? `UIFont(name: ${swiftString(style.fontFamily)}, size: ${formatNumber(style.fontSize)}) ?? .systemFont(ofSize: ${formatNumber(style.fontSize)}, weight: .${weight})`
    : `UIFont.systemFont(ofSize: ${formatNumber(style.fontSize)}, weight: .${weight})`
  // UIFontMetrics giữ đúng size Figma ở cỡ chữ mặc định nhưng vẫn scale theo Dynamic Type,
  // thay vì .systemFont cố định — xem ghi chú adjustsFontForContentSizeCategory ở nơi gọi.
  // Xuống dòng trước .scaledFont: viết liền 1 dòng vượt 120 ký tự (line_length mặc định của SwiftLint).
  return `UIFontMetrics(forTextStyle: .${nearestTextStyle(style.fontSize, style.fontWeight)})\n            .scaledFont(for: ${base})`
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
// Tên layer Figma tự sinh ("Frame 2085667793") làm outlet dài → dòng constraint dễ vượt 120 ký tự (line_length).
// Tách tham số ra từng dòng thay vì tắt rule, vì đây là code người dùng sẽ đọc/sửa.
function wrapLongConstraintLines(swift) {
  return swift.split('\n').map(line => {
    if (line.length <= 120) return line
    const match = line.match(/^(\s*)(.*\.constraint\()(.*)(\)(?:\.isActive = true)?)$/)
    if (!match) return line
    const [, pad, head, args, tail] = match
    const parts = args.split(', ')
    return [`${pad}${head}`, ...parts.map((part, index) => `${pad}    ${part}${index < parts.length - 1 ? ',' : ''}`), `${pad}${tail}`].join('\n')
  }).join('\n')
}

export function generateSwiftProgrammatic(className, root, colorRegistry) {
  return wrapLongConstraintLines(generateSwiftProgrammaticRaw(className, root, colorRegistry))
}

function generateSwiftProgrammaticRaw(className, root, colorRegistry) {
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
    if (node.meta?.rasterized) warnings.push(`${node.name}: vector/rotated artwork is exported from Figma as the image asset "${node.outlet}" (@2x/@3x) — not editable as vector in code.`)
    if (node.meta?.preservesChildrenOverImageFill) warnings.push(`${node.name}: Figma uses an image fill on a container. UIKitForge preserved its child hierarchy and exports the fill as the background image asset "${backgroundAssetName(node)}".`)
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
  const parts = foldDiacritics(value || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  let result = joinWordsCapped(parts.map(part => part.charAt(0).toUpperCase() + part.slice(1))) || fallback
  if (/^[0-9]/.test(result)) result = `View${result}`
  return result
}

// Export để preview (compiler.js) đặt outlet y hệt code Swift sinh ra — lệch tên là live preview không match được.
export function sanitizeOutletName(value) {
  const parts = foldDiacritics(value || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  let result = joinWordsCapped(parts.map((part, index) => index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1))) || 'generatedView'
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

// UIColor(named:) là failable init (UIColor?) — phải optional-chain `.cgColor`; literal UIColor(red:...) thì không.
// borderColor/shadowColor nhận CGColor? nên gán nil (asset thiếu) vẫn compile và chỉ mất màu, không crash.
function cgColor(uiColorExpression) {
  return uiColorExpression.startsWith('UIColor(named:') ? `${uiColorExpression}?.cgColor` : `${uiColorExpression}.cgColor`
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
// Tên layer Figma có thể lẫn ký tự điều khiển vô hình (vd U+001D trước "Title") — XML 1.0 cấm hẳn, kể cả dạng &#x1D;,
// nên ibtool báo "invalid character in attribute value". Bỏ chúng đi thay vì escape.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g
function xmlEscape(value) { return String(value ?? '').replace(XML_INVALID_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
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
