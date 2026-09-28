import { foldDiacritics } from './identifier.js'

// Gom màu sắc dùng trong toàn bộ 1 lần compile (UIKit + SwiftUI, main screen + mọi component) thành các
// named color dùng chung, thay vì UIColor(red:green:blue:alpha:)/Color(red:...) rải rác. Cùng giá trị RGBA
// luôn map về cùng 1 tên (dedupe theo giá trị), nên UIKit và SwiftUI tham chiếu đúng một Color Asset,
// và bật được Dark Mode thật (sửa "Any Appearance"/"Dark Appearance" trong Xcode) mà không phải sửa code.
// `names` (tuỳ chọn): bảng rgba → tên đã chốt từ lượt compile trước (xem planColorNames) — tên màu phụ thuộc mọi
// nơi dùng màu đó, mà lúc đăng ký lần đầu chưa biết hết.
export function createColorRegistry({ names = null } = {}) {
  const byValue = new Map() // normalized rgba string -> asset name
  const hintsByValue = new Map() // normalized rgba -> Set(hint) — mọi vai trò màu được dùng
  const usedNames = new Set()
  const entries = []

  function register(rgba, hint) {
    const normalized = normalizeRgba(rgba)
    if (!hintsByValue.has(normalized)) hintsByValue.set(normalized, new Set())
    hintsByValue.get(normalized).add(sanitizeHint(hint))
    if (byValue.has(normalized)) return byValue.get(normalized)

    const name = reserveName(names?.get(normalized) || sanitizeHint(hint))
    byValue.set(normalized, name)
    entries.push({ name, rgba: normalized })
    return name
  }

  function reserveName(base) {
    let name = base
    for (let n = 2; usedNames.has(name); n++) name = `${base}${n}`
    usedNames.add(name)
    return name
  }

  const usage = () => entries.map(({ rgba }) => ({ rgba, hints: [...hintsByValue.get(rgba)] }))
  return { register, entries: () => entries.slice(), usage }
}

const ROLE_PATTERN = /(Background|Text|Run|Border|Shadow|Gradient)\d*$/
const ROLE_NAME = { Background: 'background', Text: 'text', Run: 'text', Border: 'border', Shadow: 'shadow', Gradient: 'gradient' }

// Tên màu cuối cùng: 1) tên style Figma (designer đặt, ví dụ "Primary/Blue 500" → primaryBlue500); 2) chỉ một nơi
// dùng → tên theo nơi đó như trước (cardBackground); 3) nhiều nơi → tên theo giá trị (+ vai trò nếu chung vai trò),
// tránh kiểu màu trắng tên "glowGradient" nhưng lại dùng cho chữ của view khác.
export function planColorNames(usage, styleNames = new Map()) {
  const names = new Map()
  const used = new Set()
  for (const { rgba, hints } of usage) {
    const styleName = styleNames.get(normalizeRgba(rgba))
    let base
    if (styleName) base = sanitizeHint(styleName)
    else if (hints.length === 1) base = hints[0]
    else {
      const roles = new Set(hints.map(hint => ROLE_NAME[hint.match(ROLE_PATTERN)?.[1]] || 'color'))
      const value = valueName(rgba)
      const role = roles.size === 1 && !roles.has('color') ? [...roles][0] : null
      // text + color33404A → text33404A; text + white → textWhite.
      base = !role ? value : value.startsWith('color') ? `${role}${value.slice(5)}` : `${role}${value.charAt(0).toUpperCase()}${value.slice(1)}`
    }
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}${n}`
    used.add(name)
    names.set(normalizeRgba(rgba), name)
  }
  return names
}

function valueName(rgba) {
  const [r, g, b, a] = normalizeRgba(rgba).match(/[\d.]+/g).map(Number)
  const hex = [r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()
  const base = hex === 'FFFFFF' ? 'white' : hex === '000000' ? 'black' : `color${hex}`
  return a < 1 ? `${base}${Math.round(a * 100)}` : base
}

// Màu gắn Figma style (node.styles.fill/stroke → styles[id].name). Style là thứ designer đặt tên có chủ đích nên được
// ưu tiên hơn mọi tên suy ra. Variables không có qua REST (chỉ Enterprise) nên chưa dùng được.
export function styleColorNames(root, styles = {}) {
  const names = new Map()
  const visit = node => {
    if (!node || node.visible === false) return
    for (const [key, paintsKey] of [['fill', 'fills'], ['stroke', 'strokes'], ['fills', 'fills'], ['strokes', 'strokes']]) {
      const styleName = styles[node.styles?.[key]]?.name
      const paint = (node[paintsKey] || []).find(item => item?.visible !== false && item?.type === 'SOLID')
      if (!styleName || !paint?.color) continue
      const { r = 0, g = 0, b = 0, a = 1 } = paint.color
      const alpha = paint.opacity == null ? a : a * paint.opacity
      const rgba = normalizeRgba(`rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(alpha.toFixed(3))})`)
      if (!names.has(rgba)) names.set(rgba, styleName)
    }
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return names
}

function sanitizeHint(hint) {
  const parts = foldDiacritics(hint || 'color').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const joined = parts
    .map((part, index) => index === 0 ? part.charAt(0).toLowerCase() + part.slice(1) : part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'color'
  return /^[0-9]/.test(joined) ? `color${joined}` : joined
}

function normalizeRgba(value) {
  const match = String(value || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i)
  if (!match) return 'rgba(0, 0, 0, 1)'
  const round = n => Math.round(Number(n))
  const alpha = match[4] == null ? 1 : Number(Number(match[4]).toFixed(3))
  return `rgba(${round(match[1])}, ${round(match[2])}, ${round(match[3])}, ${alpha})`
}
