// Gom màu sắc dùng trong toàn bộ 1 lần compile (UIKit + SwiftUI, main screen + mọi component) thành các
// named color dùng chung, thay vì UIColor(red:green:blue:alpha:)/Color(red:...) rải rác. Cùng giá trị RGBA
// luôn map về cùng 1 tên (dedupe theo giá trị), nên UIKit và SwiftUI tham chiếu đúng một Color Asset,
// và bật được Dark Mode thật (sửa "Any Appearance"/"Dark Appearance" trong Xcode) mà không phải sửa code.
export function createColorRegistry() {
  const byValue = new Map() // normalized rgba string -> asset name
  const usedNames = new Set()
  const entries = []

  function register(rgba, hint) {
    const normalized = normalizeRgba(rgba)
    if (byValue.has(normalized)) return byValue.get(normalized)

    const name = reserveName(sanitizeHint(hint))
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

  return { register, entries: () => entries.slice() }
}

function sanitizeHint(hint) {
  const parts = String(hint || 'color').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
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
