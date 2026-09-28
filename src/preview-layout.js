// Ánh xạ Auto Layout (UIStackView + HUG/FILL/FIXED) sang CSS flexbox cho Web Preview.
// Trước đây preview đặt mọi node bằng toạ độ Figma đo sẵn (position:absolute) nên label HUG bị khoá cứng
// width của Figma — font trình duyệt rộng hơn một chút là cắt chữ, và sửa text không làm view bên cạnh co giãn.
// Flexbox cho đúng hành vi của UIStackView: con HUG theo intrinsic size, FILL chiếm phần còn lại, FIXED giữ nguyên.
//
// Hai dạng dữ liệu cùng tồn tại trong cây preview:
// - IR của compiler: node.stack (UIStackView thật sẽ sinh ra), child.arranged, child.sizing {h, v}
// - Figma thô (previewChildren của component): node.layout (mode/itemSpacing/padding/align), meta.layoutPositioning
// Ưu tiên node.stack vì đó chính là thứ code UIKit sinh ra; fallback sang node.layout.

const ALIGN_TO_CSS = { fill: 'stretch', top: 'flex-start', leading: 'flex-start', center: 'center', bottom: 'flex-end', trailing: 'flex-end', firstBaseline: 'baseline', lastBaseline: 'last baseline' }
const FIGMA_COUNTER_TO_CSS = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }
const FIGMA_PRIMARY_TO_CSS = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }

// Trả về mô tả stack chuẩn hoá { horizontal, spacing, padding, justify, align } hoặc null nếu node không phải stack.
export function resolveStack(node) {
  const layout = node?.layout || {}
  if (node?.stack) {
    const { stack } = node
    const frame = node.frame || {}
    const inner = stack.frame || {}
    // Padding: ưu tiên số gốc của Figma (đã hydrate); không có thì suy từ frame stack lồng trong container.
    const padding = layout.mode && layout.mode !== 'NONE'
      ? { top: layout.paddingTop || 0, right: layout.paddingRight || 0, bottom: layout.paddingBottom || 0, left: layout.paddingLeft || 0 }
      : {
          top: inner.y || 0,
          left: inner.x || 0,
          right: Math.max(0, (frame.width || 0) - (inner.x || 0) - (inner.width || 0)),
          bottom: Math.max(0, (frame.height || 0) - (inner.y || 0) - (inner.height || 0))
        }
    return {
      horizontal: stack.axis === 'horizontal',
      spacing: stack.spacing || 0,
      padding,
      justify: stack.distribution === 'equalSpacing' ? 'space-between' : FIGMA_PRIMARY_TO_CSS[layout.primaryAxisAlignItems] || 'flex-start',
      align: ALIGN_TO_CSS[stack.alignment] || 'stretch'
    }
  }
  if (layout.mode === 'HORIZONTAL' || layout.mode === 'VERTICAL') {
    const primary = layout.primaryAxisAlignItems || 'MIN'
    return {
      horizontal: layout.mode === 'HORIZONTAL',
      spacing: primary === 'SPACE_BETWEEN' ? 0 : layout.itemSpacing || 0,
      padding: { top: layout.paddingTop || 0, right: layout.paddingRight || 0, bottom: layout.paddingBottom || 0, left: layout.paddingLeft || 0 },
      justify: FIGMA_PRIMARY_TO_CSS[primary] || 'flex-start',
      align: FIGMA_COUNTER_TO_CSS[layout.counterAxisAlignItems] || 'flex-start'
    }
  }
  return null
}

export function isArrangedChild(child) {
  if (typeof child?.arranged === 'boolean') return child.arranged
  return (child?.meta?.layoutPositioning || 'AUTO') !== 'ABSOLUTE'
}

export function sizingOf(child) {
  if (child?.sizing) return { h: child.sizing.h || 'FIXED', v: child.sizing.v || 'FIXED' }
  return { h: child?.layout?.layoutSizingHorizontal || 'FIXED', v: child?.layout?.layoutSizingVertical || 'FIXED' }
}

export function stackContainerStyle(stack) {
  const { padding } = stack
  return {
    display: 'flex',
    flexDirection: stack.horizontal ? 'row' : 'column',
    gap: `${stack.spacing}px`,
    padding: `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`,
    justifyContent: stack.justify,
    alignItems: stack.align
  }
}

// HUG chỉ có intrinsic size thật với label và container là stack (tự co theo con); view thường/ảnh HUG
// không có nội dung để đo nên giữ kích thước Figma — tránh bị co về 0.
function hasIntrinsicSize(child) {
  return child?.kind === 'label' || Boolean(resolveStack(child))
}

export function arrangedChildStyle(child, stack) {
  const sizing = sizingOf(child)
  const frame = child.frame || {}
  const main = stack.horizontal ? 'h' : 'v'
  const cross = stack.horizontal ? 'v' : 'h'
  const sizeProp = { h: 'width', v: 'height' }
  const frameSize = { h: frame.width || 0, v: frame.height || 0 }
  const style = { position: 'relative', left: 'auto', top: 'auto', boxSizing: 'border-box' }

  const mainSizing = sizing[main] === 'HUG' && !hasIntrinsicSize(child) ? 'FIXED' : sizing[main]
  if (mainSizing === 'FILL') {
    Object.assign(style, { flex: '1 1 0px', [sizeProp[main]]: 'auto', [stack.horizontal ? 'minWidth' : 'minHeight']: '0px' })
  } else if (mainSizing === 'HUG') {
    // Ngang: cho co lại khi thiếu chỗ để label xuống dòng (như bị compress). Dọc: KHÔNG co — compression
    // resistance của UIKit giữ view đủ cao cho nội dung, co lại sẽ làm con tràn ra ngoài cha.
    Object.assign(style, stack.horizontal
      ? { flex: '0 1 auto', width: 'auto', minWidth: '0px' }
      : { flex: '0 0 auto', height: 'auto' })
  } else {
    Object.assign(style, { flex: '0 0 auto', [sizeProp[main]]: `${frameSize[main]}px` })
  }

  const crossSizing = sizing[cross] === 'HUG' && !hasIntrinsicSize(child) ? 'FIXED' : sizing[cross]
  if (crossSizing === 'FILL' || (crossSizing !== 'FIXED' && stack.align === 'stretch')) {
    Object.assign(style, { alignSelf: 'stretch', [sizeProp[cross]]: 'auto' })
  } else if (crossSizing === 'HUG') {
    Object.assign(style, { [sizeProp[cross]]: 'auto', [stack.horizontal ? 'maxHeight' : 'maxWidth']: '100%' })
  } else {
    style[sizeProp[cross]] = `${frameSize[cross]}px`
  }
  return style
}
