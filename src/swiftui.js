import { blurMaterial, formatNumber, isSystemFontFamily, repeatedInstanceGroups, todoCommentLines, parseRgba, swiftFontWeight, swiftString } from './compiler-core.js'
import { normalizeArchitecture, viperEntity, viperInteractor, viperNames, viperSharedProtocols } from './uikit-router.js'

// Sinh SwiftUI MVVM-R từ cùng IR với UIKit. Router dùng UIHostingController để chạy giống nhau từ iOS 13,
// tránh phải tách NavigationView (13) / NavigationStack (16).
export function generateSwiftUIFiles({ rootClass, mainIR, componentIRs = [], deploymentTarget = 13, colorRegistry, architecture = 'mvvm-r', scroll = null }) {
  const arch = normalizeArchitecture(architecture)
  const base = rootClass.replace(/View$/, '') || rootClass
  const names = { view: `${base}View`, viewModel: `${base}ViewModel`, router: `${base}Router` }
  const api = {
    observation: deploymentTarget >= 17,
    foregroundStyle: deploymentTarget >= 15,
    ignoresSafeArea: deploymentTarget >= 14,
    scroll
  }
  // MVC: SwiftUI không có controller — text viết thẳng trong View (texts = null), chỉ sinh 1 file View.
  const texts = arch === 'mvc' ? null : []
  const files = [swiftFile(`SwiftUI/${base}/${names.view}.swift`, generateScreenView(names, mainIR, api, texts, colorRegistry, arch), 'main')]
  if (arch !== 'mvc') files.push(swiftFile(`SwiftUI/${base}/${names.viewModel}.swift`, generateViewModel(names, texts, api, arch), 'main'))
  if (arch === 'mvvm-r') files.push(swiftFile(`SwiftUI/${base}/${names.router}.swift`, generateRouter(names), 'main'))
  if (arch === 'viper') files.splice(0, files.length, ...generateViperFiles(base, names, mainIR, api, colorRegistry))
  for (const { className, ir } of componentIRs) {
    files.push(swiftFile(`SwiftUI/Components/${className}.swift`, generateComponentView(className, ir, api, colorRegistry), 'component'))
  }
  return files
}

function swiftFile(path, content, kind) {
  let withHelpers = content.includes('CornerRadiiShape(') ? `${content}${CORNER_RADII_SHAPE}` : content
  if (content.includes('BlurBackground(')) withHelpers += BLUR_BACKGROUND
  return { path, name: path.split('/').pop(), language: 'swift', content: wrapLongComments(withHelpers), kind, target: 'swiftui' }
}

// Material của SwiftUI (.ultraThinMaterial) chỉ có từ iOS 15 — bọc UIVisualEffectView để chạy từ iOS 13 như UIKit.
const BLUR_BACKGROUND = `
private struct BlurBackground: UIViewRepresentable {
    let style: UIBlurEffect.Style

    func makeUIView(context: Context) -> UIVisualEffectView {
        UIVisualEffectView(effect: UIBlurEffect(style: style))
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        uiView.effect = UIBlurEffect(style: style)
    }
}
`

// private (fileprivate ở top level) → mỗi file tự mang helper mà không trùng khai báo khi build chung target.
// addArc(tangent1End:tangent2End:) với radius 0 vẽ thẳng tới góc, nên góc vuông không cần xử lý riêng.
const CORNER_RADII_SHAPE = `
private struct CornerRadiiShape: Shape {
    /// Thứ tự như Figma: trên-trái, trên-phải, dưới-phải, dưới-trái.
    let radii: [CGFloat]

    func path(in rect: CGRect) -> Path {
        let limit = min(rect.width, rect.height) / 2
        let corners = [
            CGPoint(x: rect.minX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.maxY),
            CGPoint(x: rect.minX, y: rect.maxY)
        ]
        var path = Path()
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

// Comment TODO được thụt lề theo độ sâu view nên chỉ biết độ dài thật ở bước cuối — tách lại ở đây cho line_length 120.
function wrapLongComments(content, width = 120) {
  return content.split('\n').flatMap(line => {
    const match = line.match(/^(\s*)\/\/ (.*)$/)
    if (line.length <= width || !match || match[2].startsWith('swiftlint:')) return [line]
    const [, pad, text] = match
    const out = []
    let current = `${pad}//`
    for (const word of text.split(' ')) {
      if (current.length + word.length + 1 > width && current.trim() !== '//') {
        out.push(current)
        current = `${pad}//  `
      }
      current += ` ${word}`
    }
    return [...out, current]
  }).join('\n')
}

// VIPER SwiftUI: View (struct) quan sát Presenter — Presenter giữ state text như ViewModel, Interactor/Router
// giống UIKit. Presenter giữ strong Interactor/Router; Interactor.output và Router.viewController là weak.
function generateViperFiles(base, names, mainIR, api, colorRegistry) {
  const n = viperNames(base)
  const texts = []
  const file = (name, content) => swiftFile(`SwiftUI/${base}/${name}.swift`, content, 'main')
  const view = generateScreenView(names, mainIR, api, texts, colorRegistry, 'viper', n)
  return [
    file(n.contract, `import Foundation\n\n${viperSharedProtocols(n)}`),
    file(names.view, view),
    file(n.presenter, generateViperPresenter(n, texts, api)),
    file(n.interactor, viperInteractor(n)),
    file(n.router, `import SwiftUI\nimport UIKit\n\nfinal class ${n.router} {\n    weak var viewController: UIViewController?\n\n    static func createModule() -> UIViewController {\n        let interactor = ${n.interactor}()\n        let router = ${n.router}()\n        let presenter = ${n.presenter}(interactor: interactor, router: router)\n        interactor.output = presenter\n        let viewController = UIHostingController(rootView: ${names.view}(presenter: presenter))\n        router.viewController = viewController\n        return viewController\n    }\n}\n\nextension ${n.router}: ${n.routerProtocol} {}\n`),
    file(n.entity, viperEntity(n))
  ]
}

function generateViperPresenter(n, texts, api) {
  const header = api.observation
    ? `import Observation\n\n@Observable\nfinal class ${n.presenter} {`
    : `import Combine\n\nfinal class ${n.presenter}: ObservableObject {`
  const state = textProperties(texts, api)
  const stateBlock = state.length ? `${state.join('\n')}\n\n` : ''
  return `${header}\n${stateBlock}    private let interactor: ${n.interactorInput}\n    private let router: ${n.routerProtocol}\n\n    init(\n        interactor: ${n.interactorInput},\n        router: ${n.routerProtocol}\n    ) {\n        self.interactor = interactor\n        self.router = router\n    }\n}\n\nextension ${n.presenter}: ${n.interactorOutput} {}\n`
}

function generateScreenView(names, root, api, texts, colorRegistry, arch = 'mvvm-r', viper = null) {
  const owner = arch === 'viper' ? 'presenter' : 'viewModel'
  const ctx = createContext(api, texts, colorRegistry, owner)
  const groups = repeatedInstanceGroups(root)
  ctx.itemGroups = new Map(groups.flatMap(group => group.nodes.map((node, index) => [node.id, { group, index }])))
  for (const group of groups) ctx.used.add(group.name)
  const content = renderContent(root, ctx, true)
  // Màn cao hơn thiết bị → ScrollView; khung Figma cố định thì ghim chiều cao (ScrollView đề xuất chiều cao vô hạn,
  // nội dung dùng maxHeight: .infinity sẽ không có kích thước xác định).
  const scrolled = api.scroll
    ? ['ScrollView {', ...indent(api.scroll.fixedHeight ? expression(content, [`.frame(height: ${formatNumber(api.scroll.height)})`]) : content, 1), '}']
    : content
  const body = expression(scrolled, [api.ignoresSafeArea ? '.ignoresSafeArea()' : '.edgesIgnoringSafeArea(.all)'])
  const ownerType = viper ? viper.presenter : names.viewModel
  const property = arch === 'mvc' ? '' : api.observation ? `    let ${owner}: ${ownerType}\n\n` : `    @ObservedObject var ${owner}: ${ownerType}\n\n`
  // VIPER: tách dòng để preview không vượt line_length khi tên màn hình dài.
  const construct = arch === 'mvc' ? `${names.view}()`
    : arch === 'mvvm' ? `${names.view}(viewModel: ${names.viewModel}())`
      : viper ? `${names.view}(\n        presenter: ${viper.presenter}(\n            interactor: ${viper.interactor}(),\n            router: ${viper.router}()\n        )\n    )`
        : `${names.view}(\n        viewModel: ${names.viewModel}(router: ${names.router}())\n    )`
  const preview = api.observation
    ? `#Preview {\n    ${construct}\n}`
    : `struct ${names.view}Previews: PreviewProvider {\n    static var previews: some View {\n        ${construct.replace(/\n/g, '\n    ')}\n    }\n}`
  const items = groups.flatMap(itemsProperty)
  return `import SwiftUI\n\nstruct ${names.view}: View {\n${property}${items.length ? `${items.join('\n')}\n` : ''}    var body: some View {\n${indent(body, 2).join('\n')}\n    }\n}\n${sectionsExtension(names.view, ctx)}\n${preview}\n`
}

function generateComponentView(className, root, api, colorRegistry) {
  const ctx = createContext(api, null, colorRegistry)
  // Nội dung khác nhau giữa các instance → `var` có giá trị mặc định (instance gốc); memberwise init cho phép
  // màn chính truyền giá trị riêng từng instance mà không cần viết init tay.
  const slots = root.slots || []
  ctx.textSlots = new Map(slots.filter(slot => slot.kind === 'text').map(slot => [slot.nodeId, slot.param]))
  ctx.hiddenSlots = new Map(slots.filter(slot => slot.kind === 'hidden').map(slot => [slot.nodeId, slot.param]))
  for (const slot of slots) ctx.used.add(slot.param)
  const slotLines = slots
    .map(slot => `    var ${slot.param} = ${slot.kind === 'text' ? swiftString(slot.fallback) : 'false'}`)
    .flatMap(line => line.length > 120 ? ['    // swiftlint:disable:next line_length', line] : [line])
  // Component nút: `action` đặt cuối để memberwise init vẫn gọi được như cũ (ButtonsButtonView()).
  if (root.meta?.isButton) slotLines.push('    var action: () -> Void = {}')
  const stored = slotLines.length ? `${slotLines.join('\n')}\n\n` : ''
  const content = renderContent(root, ctx, true)
  // Plain style: giữ nguyên giao diện thiết kế (không tô màu accent), vẫn có hiệu ứng nhấn + trait nút cho VoiceOver.
  const body = root.meta?.isButton
    ? ['Button(action: action) {', ...indent(content, 1), '}', api.foregroundStyle ? '.buttonStyle(.plain)' : '.buttonStyle(PlainButtonStyle())']
    : content
  const preview = api.observation
    ? `#Preview {\n    ${className}()\n}`
    : `struct ${className}Previews: PreviewProvider {\n    static var previews: some View {\n        ${className}()\n    }\n}`
  return `import SwiftUI\n\nstruct ${className}: View {\n${stored}    var body: some View {\n${indent(body, 2).join('\n')}\n    }\n}\n${sectionsExtension(className, ctx)}${itemExtension(className, slots, root.meta?.isButton)}\n${preview}\n`
}

// Dữ liệu 1 instance (id + các slot) — màn hình giữ mảng Item và dựng component bằng ForEach thay vì N lời gọi rời.
// init(item:) gọi lại memberwise init nên lời gọi cũ (PlanCardView(view3GBText: ...)) vẫn dùng được.
function itemExtension(className, slots, isButton) {
  if (!slots.length) return ''
  const fields = slots
    .map(slot => `        var ${slot.param} = ${slot.kind === 'text' ? swiftString(slot.fallback) : 'false'}`)
    .flatMap(line => line.length > 120 ? ['        // swiftlint:disable:next line_length', line] : [line])
  const args = [...slots.map(slot => `${slot.param}: item.${slot.param}`), ...(isButton ? ['action: action'] : [])]
  const params = isButton ? 'item: Item, action: @escaping () -> Void = {}' : 'item: Item'
  return `\nextension ${className} {\n    struct Item: Identifiable {\n        let id: Int\n${fields.join('\n')}\n    }\n\n    init(${params}) {\n        self.init(\n${args.map((arg, index) => `            ${arg}${index < args.length - 1 ? ',' : ''}`).join('\n')}\n        )\n    }\n}\n`
}

// Mảng Item của màn hình (giá trị thiết kế) — chỗ thay bằng dữ liệu thật (ViewModel/API) chỉ còn một nơi.
function itemsProperty(group) {
  const items = group.nodes.flatMap((node, index) => [
    '        .init(',
    `            id: ${index},`,
    ...node.overrides.flatMap(({ slot, value }, argIndex) => {
      const line = `            ${slot.param}: ${slot.kind === 'text' ? swiftString(value) : String(value)}${argIndex < node.overrides.length - 1 ? ',' : ''}`
      return line.length > 120 ? ['            // swiftlint:disable:next line_length', line] : [line]
    }),
    `        )${index < group.nodes.length - 1 ? ',' : ''}`
  ])
  return [`    private let ${group.name}: [${group.className}.Item] = [`, ...items, '    ]', '']
}

function textProperties(texts, api) {
  return texts.map(({ property, value }) => api.observation
    ? `    private(set) var ${property} = ${swiftString(value)}`
    : `    @Published private(set) var ${property} = ${swiftString(value)}`)
    // Câu text dài từ Figma không bẻ được — chỉ tắt line_length cho đúng dòng đó (ngưỡng 120 như .swiftlint.yml).
    .flatMap(line => line.length > 120 ? ['    // swiftlint:disable:next line_length', line] : [line])
}

function generateViewModel(names, texts, api, arch = 'mvvm-r') {
  const properties = textProperties(texts, api)
  const header = api.observation
    ? `import Observation\n\n@Observable\nfinal class ${names.viewModel} {`
    : `import Combine\n\nfinal class ${names.viewModel}: ObservableObject {`
  const stateBlock = properties.length ? `${properties.join('\n')}\n\n` : ''
  // MVVM không có Router: VM chỉ giữ state text (bỏ dòng trống thừa cuối stateBlock để SwiftLint không bắt vertical_whitespace).
  if (arch === 'mvvm') return `${header}\n${stateBlock.replace(/\n\n$/, '\n')}}\n`
  return `${header}\n${stateBlock}    private let router: ${names.router}\n\n    init(router: ${names.router}) {\n        self.router = router\n    }\n}\n`
}

function generateRouter(names) {
  return `import SwiftUI\nimport UIKit\n\nfinal class ${names.router} {\n    weak var viewController: UIViewController?\n\n    static func makeViewController() -> UIViewController {\n        let router = ${names.router}()\n        let viewModel = ${names.viewModel}(router: router)\n        let viewController = UIHostingController(rootView: ${names.view}(viewModel: viewModel))\n        router.viewController = viewController\n        return viewController\n    }\n}\n`
}

function createContext(api, texts, colorRegistry, owner = 'viewModel') {
  return { api, texts, colorRegistry, owner, sections: [], used: new Set(['body', 'viewModel', 'presenter']) }
}

function uniqueName(ctx, base) {
  let name = base
  for (let n = 2; ctx.used.has(name); n++) name = `${base}${n}`
  ctx.used.add(name)
  return name
}

// Mỗi container con tách thành computed property riêng để body ngắn, tránh vượt type_body_length của SwiftLint.
// ponytail: tất cả section nằm chung một extension; màn hình cực lớn vẫn có thể chạm ngưỡng 250 dòng.
function sectionsExtension(typeName, ctx) {
  if (!ctx.sections.length) return ''
  const blocks = ctx.sections.map(({ name, lines }) => `    var ${name}: some View {\n${indent(lines, 2).join('\n')}\n    }`)
  return `\nprivate extension ${typeName} {\n${blocks.join('\n\n')}\n}\n`
}

// Thứ tự modifier: nội dung → kích thước → style → vị trí, để background/clip phủ đúng khung như UIView.
function renderContent(node, ctx, isRoot = false, sizeModifiers = []) {
  const lines = renderContentLines(node, ctx, isRoot, sizeModifiers)
  // Ghi chú TODO đặt một lần trước view: bỏ qua lớp bọc Group (lần gọi bên trong sẽ ghi) và tham chiếu section
  // (thân section ghi), tránh lặp. Comment trong ViewBuilder không ảnh hưởng implicit return.
  const wrapper = (!isRoot && ctx.hiddenSlots?.has(node.id) && ctx.skipHidden !== node.id) || (!isRoot && node.kind === 'view' && node.children.length)
  return wrapper ? lines : [...todoCommentLines(node, ''), ...lines]
}

function renderContentLines(node, ctx, isRoot, sizeModifiers) {
  // Phần tử ẩn ở vài instance: bọc Group + if để modifier vị trí/kích thước của cha vẫn gắn hợp lệ, và khi ẩn thì
  // rút khỏi stack như UIView.isHidden trong UIStackView.
  if (!isRoot && ctx.hiddenSlots?.has(node.id) && ctx.skipHidden !== node.id) {
    const inner = renderContent(node, { ...ctx, skipHidden: node.id }, false, sizeModifiers)
    return ['Group {', `    if !${ctx.hiddenSlots.get(node.id)} {`, ...indent(inner, 2), '    }', '}']
  }
  if (!isRoot && node.kind === 'view' && node.children.length) {
    const name = uniqueName(ctx, `${node.outlet}Section`)
    const section = { name, lines: [] }
    ctx.sections.push(section)
    section.lines = renderContent(node, ctx, true)
    return expression([name], sizeModifiers)
  }
  if (node.kind === 'label') {
    const [base, ...modifiers] = labelLines(node, ctx)
    return expression(Array.isArray(base) ? base : [base], [...modifiers, ...sizeModifiers, ...styleModifiers(node, false, ctx)])
  }
  if (node.kind === 'image') return expression([`Image(${swiftString(node.outlet)})`], ['.resizable()', '.scaledToFit()', ...sizeModifiers, ...styleModifiers(node, true, ctx)])
  if (node.kind === 'component') return expression(componentCall(node, ctx), sizeModifiers)
  const { base, modifiers } = containerLines(node, ctx)
  return expression(base, [...modifiers, ...sizeModifiers, ...styleModifiers(node, true, ctx)])
}

// SwiftFormat: modifier sau view một dòng thì thụt vào; sau block/lời gọi nhiều dòng (kết thúc "}" hoặc ")") thì thẳng hàng.
function expression(lines, modifiers) {
  const head = lines.find(line => !line.trimStart().startsWith('//')) || ''
  return [...lines, ...(head.endsWith('{') || head.endsWith('(') ? modifiers : indent(modifiers, 1))]
}

function componentCall(node, ctx) {
  const grouped = ctx?.itemGroups?.get(node.id)
  if (grouped) return [`${node.className}(item: ${grouped.group.name}[${grouped.index}])`]
  if (!node.overrides?.length) return [`${node.className}()`]
  const args = node.overrides.map(({ slot, value }, index) => `    ${slot.param}: ${slot.kind === 'text' ? swiftString(value) : String(value)}${index < node.overrides.length - 1 ? ',' : ''}`)
  return [`${node.className}(`, ...args, ')']
}

function labelLines(node, ctx) {
  const { style } = node
  let textExpression = swiftString(node.text)
  // Đoạn khác weight → ghép Text + Text (iOS 13+); không đưa qua ViewModel vì chuỗi đơn không mang được kiểu từng đoạn.
  const runsBase = node.textRuns ? textRunLines(node, ctx) : null
  if (runsBase) {
    textExpression = null
  } else if (ctx.textSlots?.has(node.id)) {
    textExpression = ctx.textSlots.get(node.id)
  } else if (ctx.texts) {
    const property = uniqueName(ctx, node.outlet === 'router' ? 'routerText' : node.outlet)
    ctx.texts.push({ property, value: node.text })
    textExpression = `${ctx.owner}.${property}`
  }
  const lines = [runsBase || `Text(${textExpression})`]
  if (style.fontFamily && !isSystemFontFamily(style.fontFamily)) {
    lines.push(`.font(.custom(${swiftString(style.fontFamily)}, size: ${formatNumber(style.fontSize)}))`, `.fontWeight(.${swiftFontWeight(style.fontWeight)})`)
  } else {
    lines.push(`.font(.system(size: ${formatNumber(style.fontSize)}, weight: .${swiftFontWeight(style.fontWeight)}))`)
  }
  // kerning/underline/strikethrough là modifier của Text (iOS 13) → đặt trước các modifier View bên dưới.
  if (style.letterSpacing) lines.push(`.kerning(${formatNumber(style.letterSpacing)})`)
  // Có runs thì gạch được gắn theo từng đoạn (textRunLines) — gắn ở ngoài sẽ đè cả đoạn không gạch.
  if (style.textDecoration && !runsBase) lines.push(TEXT_DECORATION[style.textDecoration])
  if (style.textColor) lines.push(`${ctx.api.foregroundStyle ? '.foregroundStyle' : '.foregroundColor'}(${color(ctx, style.textColor, `${node.outlet}Text`)})`)
  if (style.textAlign === 'center' || style.textAlign === 'right') lines.push(`.multilineTextAlignment(${style.textAlign === 'center' ? '.center' : '.trailing'})`)
  if (style.numberOfLines === 1) lines.push('.lineLimit(1)')
  // SwiftUI chỉ cho thêm khoảng giữa các dòng: line height Figma trừ chiều cao dòng tự nhiên (~1.19 × cỡ chữ với SF Pro).
  const spacing = Math.round((style.lineHeight - style.fontSize * 1.19) * 100) / 100
  if (style.lineHeight > 0 && style.numberOfLines !== 1 && spacing > 0) lines.push(`.lineSpacing(${formatNumber(spacing)})`)
  return lines
}

const TEXT_DECORATION = { UNDERLINE: '.underline()', STRIKETHROUGH: '.strikethrough()' }

// Modifier trên từng Text con được ưu tiên hơn modifier gắn ngoài cả biểu thức (font/màu gốc của label).
function textRunLines(node, ctx) {
  const parts = node.textRuns.map((run, index) => {
    const modifiers = [
      run.fontWeight !== node.style.fontWeight ? `.fontWeight(.${swiftFontWeight(run.fontWeight)})` : '',
      run.color && run.color !== node.style.textColor
        ? `${ctx.api.foregroundStyle ? '.foregroundStyle' : '.foregroundColor'}(${color(ctx, run.color, `${node.outlet}Run`)})`
        : '',
      run.decoration ? TEXT_DECORATION[run.decoration] : ''
    ].join('')
    const piece = `Text(${swiftString(run.text)})${modifiers}`
    return index === 0 ? `    ${piece}` : `        + ${piece}`
  })
  return ['(', ...parts.flatMap(line => line.length > 100 ? ['    // swiftlint:disable:next line_length', line] : [line]), ')']
}

function itemRun(arranged, start, ctx, stack) {
  const first = ctx.itemGroups?.get(arranged[start].id)
  if (!first || stack.distribution === 'equalSpacing') return [arranged[start]]
  const modifiers = arrangedModifiers(arranged[start], stack).join('\n')
  const run = [arranged[start]]
  for (let index = start + 1; index < arranged.length; index++) {
    const next = ctx.itemGroups.get(arranged[index].id)
    if (next?.group !== first.group || next.index !== first.index + run.length || arrangedModifiers(arranged[index], stack).join('\n') !== modifiers) break
    run.push(arranged[index])
  }
  return run
}

function containerLines(node, ctx) {
  const pinned = node.stack ? node.children.filter(child => !child.arranged) : node.children
  if (!node.stack) return { base: node.children.length ? zStackLines(pinned, ctx) : ['Color.clear'], modifiers: [] }
  const { base, modifiers } = stackLines(node, ctx)
  if (pinned.length) modifiers.push('.overlay(', ...indent(zStackLines(pinned, ctx), 1), ')')
  return { base, modifiers }
}

function stackLines(node, ctx) {
  const { stack } = node
  const horizontal = stack.axis === 'horizontal'
  const arranged = node.children.filter(child => child.arranged)
  const children = []
  for (let index = 0; index < arranged.length; index++) {
    const child = arranged[index]
    if (index > 0 && stack.distribution === 'equalSpacing') children.push('Spacer(minLength: 0)')
    const run = itemRun(arranged, index, ctx, stack)
    if (run.length > 1) {
      // Instance liên tiếp cùng component, cùng modifier → ForEach trên đoạn mảng tương ứng.
      const { group, index: first } = ctx.itemGroups.get(child.id)
      const view = expression([`${child.className}(item: item)`], arrangedModifiers(child, stack))
      children.push(`ForEach(${group.name}[${first}..<${first + run.length}]) { item in`, ...indent(view, 1), '}')
      index += run.length - 1
      continue
    }
    children.push(...renderContent(child, ctx, false, arrangedModifiers(child, stack)))
  }
  const base = [`${horizontal ? 'HStack' : 'VStack'}(alignment: ${swiftStackAlignment(stack)}, spacing: ${formatNumber(stack.spacing)}) {`, ...indent(children, 1), '}']
  const lines = []
  const insets = {
    top: stack.frame.y,
    leading: stack.frame.x,
    bottom: node.frame.height - stack.frame.y - stack.frame.height,
    trailing: node.frame.width - stack.frame.x - stack.frame.width
  }
  const paddingLine = edgeInsets(insets)
  if (paddingLine) lines.push(paddingLine)
  const frame = flexibleFrame(node.sizing.h !== 'HUG', node.sizing.v !== 'HUG', stackContentAlignment(stack))
  if (frame) lines.push(frame)
  return { base, modifiers: lines }
}

function zStackLines(children, ctx) {
  return ['ZStack(alignment: .topLeading) {', ...indent(children.flatMap(child => {
    const { size, position } = pinnedModifiers(child)
    return expression(renderContent(child, ctx, false, size), position)
  }), 1), '}']
}

function arrangedModifiers(child, stack) {
  const fill = axis => child.sizing[axis] === 'FILL' || (stack.alignment === 'fill' && axis !== (stack.axis === 'horizontal' ? 'h' : 'v'))
  const fixed = axis => child.sizing[axis] === 'FIXED' && child.kind !== 'label' && !fill(axis)
  const lines = []
  const fixedFrame = sizeFrame(fixed('h') ? child.frame.width : null, fixed('v') ? child.frame.height : null)
  if (fixedFrame) lines.push(fixedFrame)
  const flexible = flexibleFrame(fill('h'), fill('v'), child.kind === 'label' ? textAlignment(child) : null)
  if (flexible) lines.push(flexible)
  return lines
}

// Chuyển constraint pin (đã suy luận cho UIKit) sang frame + padding trong ZStack: một nguồn sự thật cho cả hai output.
function pinnedModifiers(child) {
  const byType = Object.fromEntries((child.constraints || []).map(item => [item.type, item]))
  const h = pinnedAxis(byType.leading, byType.trailing, byType.centerX, byType.width)
  const v = pinnedAxis(byType.top, byType.bottom, byType.centerY, byType.height)
  const size = []
  const fixedFrame = sizeFrame(h.size, v.size)
  if (fixedFrame) size.push(fixedFrame)
  if (child.kind === 'label' && h.align === 'fill') size.push(flexibleFrame(true, false, textAlignment(child)))
  const position = []
  if (h.offset || v.offset) position.push(`.offset(x: ${formatNumber(h.offset || 0)}, y: ${formatNumber(v.offset || 0)})`)
  const paddingLine = edgeInsets({ top: v.start, leading: h.start, bottom: v.end, trailing: h.end })
  if (paddingLine) position.push(paddingLine)
  position.push(flexibleFrame(true, true, combineAlignment(h.align, v.align)))
  return { size, position }
}

function pinnedAxis(start, end, center, size) {
  const fixedSize = size?.constant ?? null
  if (start && end && !start.atLeast && !end.atLeast) return { align: 'fill', start: start.constant, end: end.constant, size: null }
  if (end && !end.atLeast) return { align: 'end', end: end.constant, size: fixedSize }
  if (center) return { align: 'center', offset: center.constant, size: fixedSize }
  return { align: 'start', start: start?.constant || 0, size: fixedSize }
}

// Góc khác nhau → CornerRadiiShape tự vẽ (UnevenRoundedRectangle chỉ có từ iOS 17, export còn hỗ trợ iOS 13).
function shapeExpression(style) {
  if (style.cornerRadii) return `CornerRadiiShape(radii: [${style.cornerRadii.map(formatNumber).join(', ')}])`
  return `RoundedRectangle(cornerRadius: ${formatNumber(style.radius || 0)})`
}

function styleModifiers(node, includeShape, ctx) {
  const { style } = node
  const hint = node.outlet || 'root'
  const lines = []
  const fill = style.gradient && node.kind !== 'image' ? gradientLines(node, ctx, hint)
    : style.background ? [color(ctx, style.background, `${hint}Background`)] : null
  // Chỉ clip khi Figma bật clipsContent (hoặc ảnh cần bo): bo góc nền bằng RoundedRectangle.fill thì phần tử tràn
  // góc (nhãn "Hot") không bị cắt — .clipShape sẽ cắt luôn cả overlay.
  const clips = style.clipsContent || node.kind === 'image'
  const shape = shapeExpression(style)
  // Inner shadow gắn trước fill/ảnh nền → nằm trên fill nhưng dưới nội dung/view con (như Figma); overlay sẽ đè lên con.
  if (includeShape && style.innerShadow) lines.push(...innerShadowModifier(style, shape, ctx, hint))
  // Ảnh nền đặt trước màu nền (background sau nằm dưới). Color.clear nhận đúng khung view, ảnh scaledToFill tràn ra
  // được .clipped() cắt theo khung đó — không clip cả view (con tràn góc vẫn hiện).
  if (style.backgroundImage) {
    const mode = style.backgroundImage.scaleMode === 'FIT' ? '.scaledToFit()' : style.backgroundImage.scaleMode === 'FILL' || !style.backgroundImage.scaleMode ? '.scaledToFill()' : ''
    lines.push('.background(', '    Color.clear', '        .overlay(', `            Image(decorative: ${swiftString(`${node.outlet}Background`)})`, '                .resizable()',
      ...(mode ? [`                ${mode}`] : []), '        )', '        .clipped()', ')')
  }
  if (fill && includeShape && style.radius > 0 && !clips) {
    lines.push('.background(', `    ${shape}`, '        .fill(', ...indent(fill, 3), '        )', ')')
  } else if (fill) {
    lines.push(...(fill.length === 1 ? [`.background(${fill[0]})`] : ['.background(', ...indent(fill, 1), ')']))
  }
  // Blur nền nằm dưới fill (background gắn sau thì nằm dưới) và được cắt theo hình của view.
  if (includeShape && style.backgroundBlur) {
    lines.push('.background(', `    BlurBackground(style: .${blurMaterial(style.backgroundBlur)})`, `        .clipShape(${shape})`, ')')
  }
  if (includeShape && style.radius > 0 && clips) lines.push(`.clipShape(${shape})`)
  if (includeShape && style.borderColor && style.borderWidth > 0) {
    lines.push(
      '.overlay(',
      `    ${shape}`,
      `        .stroke(${color(ctx, style.borderColor, `${hint}Border`)}, lineWidth: ${formatNumber(style.borderWidth)})`,
      ')'
    )
  }
  if (style.shadow) {
    const { shadow } = style
    lines.push(
      '.shadow(',
      `    color: ${color(ctx, shadow.color || 'rgba(0, 0, 0, 0.2)', `${hint}Shadow`)},`,
      `    radius: ${formatNumber(shadow.blur / 2)},`,
      `    x: ${formatNumber(shadow.x)},`,
      `    y: ${formatNumber(shadow.y)}`,
      ')'
    )
  }
  if (style.layerBlur) lines.push(`.blur(radius: ${formatNumber(style.layerBlur / 2)})`)
  if (style.opacity < 1) lines.push(`.opacity(${formatNumber(style.opacity)})`)
  return lines
}

// Inner shadow: viền dày = blur, làm mờ, dịch theo offset rồi mask theo chính hình view → bóng chỉ nằm phía trong.
// Là background (không phải overlay) để nằm dưới view con.
function innerShadowModifier(style, shape, ctx, hint) {
  const shadow = style.innerShadow
  return [
    '.background(',
    `    ${shape}`,
    `        .stroke(${color(ctx, shadow.color || 'rgba(0, 0, 0, 0.25)', `${hint}InnerShadow`)}, lineWidth: ${formatNumber(Math.max(1, shadow.blur))})`,
    `        .blur(radius: ${formatNumber(shadow.blur / 2)})`,
    `        .offset(x: ${formatNumber(shadow.x)}, y: ${formatNumber(shadow.y)})`,
    // .mask(_:) deprecated từ iOS 15 → dùng dạng closure khi target cho phép.
    ctx.api.foregroundStyle ? `        .mask { ${shape} }` : `        .mask(${shape})`,
    ')'
  ]
}

function gradientLines(node, ctx, hint) {
  const { gradient } = node.style
  const stops = gradient.stops.map((stop, index) => `        .init(color: ${color(ctx, stop.rgba, `${hint}Gradient`)}, location: ${formatNumber(stop.position)})${index < gradient.stops.length - 1 ? ',' : ''}`)
  const point = p => `UnitPoint(x: ${formatNumber(p.x)}, y: ${formatNumber(p.y)})`
  if (gradient.type === 'radial') {
    const radius = Math.hypot((gradient.end.x - gradient.start.x) * node.frame.width, (gradient.end.y - gradient.start.y) * node.frame.height)
    return ['RadialGradient(', '    gradient: Gradient(stops: [', ...stops, '    ]),', `    center: ${point(gradient.start)},`, '    startRadius: 0,', `    endRadius: ${formatNumber(Math.round(radius * 100) / 100)}`, ')']
  }
  if (gradient.type === 'angular') {
    // Góc SwiftUI: 0° hướng sang phải, tăng theo chiều kim đồng hồ (y hướng xuống) — tính theo khung thật vì handle
    // Figma ở toạ độ đơn vị (khung chữ nhật làm méo góc).
    const angle = Math.atan2((gradient.end.y - gradient.start.y) * node.frame.height, (gradient.end.x - gradient.start.x) * node.frame.width) * 180 / Math.PI
    const start = Math.round(angle * 100) / 100
    return ['AngularGradient(', '    gradient: Gradient(stops: [', ...stops, '    ]),', `    center: ${point(gradient.start)},`, `    startAngle: .degrees(${formatNumber(start)}),`, `    endAngle: .degrees(${formatNumber(start + 360)})`, ')']
  }
  return ['LinearGradient(', '    gradient: Gradient(stops: [', ...stops, '    ]),', `    startPoint: ${point(gradient.start)},`, `    endPoint: ${point(gradient.end)}`, ')']
}

function swiftStackAlignment(stack) {
  if (stack.axis === 'horizontal') return { center: '.center', bottom: '.bottom', firstBaseline: '.firstTextBaseline' }[stack.alignment] || '.top'
  return { center: '.center', trailing: '.trailing' }[stack.alignment] || '.leading'
}

// Vị trí nội dung stack trong container: trục chính suy từ pins (center / start>= / end>=), trục phụ từ alignment.
function stackContentAlignment(stack) {
  const horizontal = stack.axis === 'horizontal'
  const [start, end, center] = horizontal ? ['leading', 'trailing', 'centerX'] : ['top', 'bottom', 'centerY']
  const main = stack.pins.some(pin => pin.type === center) ? 'center'
    : stack.pins.some(pin => pin.type === start && pin.atLeast) ? 'end'
      : 'start'
  const cross = { center: 'center', bottom: 'end', trailing: 'end' }[stack.alignment] || (stack.alignment === 'firstBaseline' || stack.alignment === 'fill' ? 'center' : 'start')
  return horizontal ? combineAlignment(main, cross) : combineAlignment(cross, main)
}

function combineAlignment(h, v) {
  const vertical = { start: 'top', end: 'bottom' }[v] || (v === 'center' ? 'center' : 'top')
  const horizontal = { start: 'leading', end: 'trailing' }[h] || (h === 'center' ? 'center' : 'leading')
  if (vertical === 'center' && horizontal === 'center') return '.center'
  if (vertical === 'center') return `.${horizontal}`
  if (horizontal === 'center') return `.${vertical}`
  return `.${vertical}${horizontal.charAt(0).toUpperCase()}${horizontal.slice(1)}`
}

function textAlignment(node) {
  return { center: '.center', right: '.trailing' }[node.style.textAlign] || '.leading'
}

function sizeFrame(width, height) {
  const parts = [width != null ? `width: ${formatNumber(width)}` : '', height != null ? `height: ${formatNumber(height)}` : ''].filter(Boolean)
  return parts.length ? `.frame(${parts.join(', ')})` : ''
}

function flexibleFrame(width, height, alignment) {
  const parts = [width ? 'maxWidth: .infinity' : '', height ? 'maxHeight: .infinity' : ''].filter(Boolean)
  if (!parts.length) return ''
  if (alignment && alignment !== '.center') parts.push(`alignment: ${alignment}`)
  return `.frame(${parts.join(', ')})`
}

function edgeInsets({ top = 0, leading = 0, bottom = 0, trailing = 0 }) {
  const values = [top, leading, bottom, trailing].map(value => Number(formatNumber(value)))
  if (values.every(value => value === 0)) return ''
  return `.padding(EdgeInsets(top: ${values[0]}, leading: ${values[1]}, bottom: ${values[2]}, trailing: ${values[3]}))`
}

// Color Asset dùng chung với UIKit (cùng colorRegistry) để bật Dark Mode thật qua Colors.xcassets thay vì
// literal Color(red:...) không đổi theo appearance. Không có registry (gọi lẻ ngoài luồng compile) thì fallback literal.
function color(ctx, rgba, hint) {
  if (!ctx.colorRegistry) return literalColor(rgba)
  return `Color(${swiftString(ctx.colorRegistry.register(rgba, hint))})`
}

function literalColor(rgba) {
  const c = parseRgba(rgba) || { r: 0, g: 0, b: 0, a: 1 }
  const unit = value => Number(Math.max(0, Math.min(1, value)).toFixed(3))
  return `Color(red: ${unit(c.r)}, green: ${unit(c.g)}, blue: ${unit(c.b)}, opacity: ${unit(c.a)})`
}

function indent(lines, level) {
  const pad = '    '.repeat(level)
  return lines.map(line => line ? `${pad}${line}` : line)
}
