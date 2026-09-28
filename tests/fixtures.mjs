import { readFileSync } from 'node:fs'

const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
const text = (id, name, x, y, w, h, extra = {}) => ({ id, type: 'TEXT', name, characters: name, style: { fontSize: 14, textAutoResize: 'HEIGHT' }, ...box(x, y, w, h), ...extra })

export const layoutScreen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Screen', ...box(0, 0, 390, 844),
    children: [
      {
        // Stack ngang: icon fixed, title fill, 2 label → kiểm tra FILL + compression.
        id: '1:2', type: 'FRAME', name: 'Row', layoutMode: 'HORIZONTAL', itemSpacing: 8,
        paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12,
        counterAxisAlignItems: 'CENTER', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG',
        constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' }, ...box(0, 100, 390, 48),
        children: [
          { id: '1:3', type: 'RECTANGLE', name: 'Icon', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', ...box(16, 112, 24, 24) },
          text('1:4', 'Title', 48, 115, 200, 18, { layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG' }),
          text('1:5', 'Value', 300, 115, 74, 18, { layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' }),
          { id: '1:6', type: 'RECTANGLE', name: 'Badge', layoutPositioning: 'ABSOLUTE', constraints: { horizontal: 'RIGHT', vertical: 'TOP' }, ...box(380, 100, 8, 8) }
        ]
      },
      {
        id: '2:1', type: 'FRAME', name: 'Actions', layoutMode: 'VERTICAL', primaryAxisAlignItems: 'SPACE_BETWEEN',
        layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', ...box(16, 600, 358, 200),
        children: [
          { id: '2:2', type: 'FRAME', name: 'Primary', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED', ...box(16, 600, 358, 48) },
          { id: '2:3', type: 'FRAME', name: 'Secondary', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', ...box(16, 752, 200, 48) }
        ]
      },
      // Hai node có hậu tố id giống nhau — cách cắt chuỗi cũ sinh XIB ID trùng.
      { id: 'I10:1;99:77', type: 'RECTANGLE', name: 'A', ...box(0, 0, 10, 10) },
      { id: 'I20:1;99:77', type: 'RECTANGLE', name: 'B', ...box(20, 0, 10, 10) },
      text('3:1', 'Caption', 16, 300, 200, 18, { constraints: { horizontal: 'LEFT', vertical: 'TOP' } }),
      { id: '3:2', type: 'FRAME', name: 'Pill', layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', primaryAxisAlignItems: 'CENTER', constraints: { horizontal: 'CENTER', vertical: 'TOP' }, ...box(145, 400, 100, 32),
        children: [text('3:3', 'Pill text', 155, 407, 80, 18, { style: { fontSize: 14, textAutoResize: 'WIDTH_AND_HEIGHT' } })] }
    ]
  }
}

// Dữ liệu thật của Figma "Feed/ News" (31775:52174, đọc qua Plugin API): con trực tiếp là SLOT, label tiếng Việt
// dài (outlet dài, dòng .text > 120 ký tự). REST API trả thêm instance Ellipsis đang ẩn trong slot Header — Plugin
// API thì không — nên chèn tay vào đây để test đúng dữ liệu app nhận được.
const feedNode = JSON.parse(readFileSync(new URL('./fixtures/feed-news.json', import.meta.url), 'utf8'))
feedNode.children[0].children.push({
  id: 'I31775:52174;28278:6571', type: 'INSTANCE', name: 'Ellipsis-horizontal', visible: false, componentId: '1:999',
  absoluteBoundingBox: { x: 7158, y: 6885, width: 24, height: 24 },
  children: [{ id: 'I31775:52174;28278:6571;1:1', type: 'VECTOR', name: 'Vector', absoluteBoundingBox: { x: 7160, y: 6895, width: 20, height: 4 } }]
})
export const feedSlotScreen = { root: feedNode }

// Màn hình có component instance (stroke, shadow, image, text có dấu nháy) cho test SwiftUI.
export const cardScreen = { root: { id: '1:1', type: 'FRAME', name: 'Home', layoutMode: 'VERTICAL', itemSpacing: 12, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16,
  fills: [{ type: 'SOLID', color: { r: 0.96, g: 0.97, b: 1, a: 1 } }], absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 300 },
  children: [{ id: '2:1', type: 'INSTANCE', componentId: 'card', name: 'Package Card', cornerRadius: 12, strokeWeight: 1,
    strokes: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8, a: 1 } }], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    effects: [{ type: 'DROP_SHADOW', offset: { x: 0, y: 2 }, radius: 8, color: { r: 0, g: 0, b: 0, a: 0.1 } }],
    layoutMode: 'VERTICAL', itemSpacing: 4, paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: 12, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
    absoluteBoundingBox: { x: 16, y: 16, width: 358, height: 64 },
    children: [
      { id: '2:2', type: 'TEXT', name: 'Title', characters: 'Fast "Data"', style: { fontSize: 16, fontWeight: 600, textAlignHorizontal: 'CENTER', textAutoResize: 'HEIGHT' }, layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', absoluteBoundingBox: { x: 28, y: 28, width: 334, height: 20 } },
      { id: '2:3', type: 'RECTANGLE', name: 'Hero', fills: [{ type: 'IMAGE', imageRef: 'x' }], opacity: 0.5, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', absoluteBoundingBox: { x: 28, y: 52, width: 40, height: 40 } }
    ] }] } }

// Dữ liệu thật của Figma "Bán gói ngày" (34715:42593): gradient, vector/icon, hình xoay, text trộn đậm/thường,
// 4 instance cùng component nhưng nội dung khác nhau. Plugin API bỏ qua node ẩn còn REST thì trả về: thêm lại
// nhãn "Hot" (Scarcity) ẩn cho 2 card cuối để khớp dữ liệu app nhận được.
const banNode = JSON.parse(readFileSync(new URL('./fixtures/ban-goi-ngay.json', import.meta.url), 'utf8'))
{
  const section = banNode.children[1].children[0].children[1].children[1]
  const badge = section.children[0].children[0].children.find(child => child.name === 'Scarcity')
  for (const card of section.children[1].children) {
    const clone = JSON.parse(JSON.stringify(badge).replaceAll('31977:26511', card.id.split(';')[1]))
    clone.visible = false
    card.children.push(clone)
  }
}
export const banGoiNgayScreen = { root: banNode }

// Node "khó" (kiểu màn 34715:42593): vector, gradient linear/radial/angular, clip, bo góc từng góc, chữ nhiều kiểu.
// Nằm trong fixtures (không chỉ trong test) để CI macOS typecheck/lint code Swift sinh ra từ chúng.
const stop = (position, r, g, b) => ({ position, color: { r, g, b, a: 1 } })
const solid = (r, g, b) => [{ type: 'SOLID', color: { r, g, b, a: 1 } }]
export const fidelityScreen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Promo', ...box(0, 0, 390, 560),
    children: [
      { id: '1:2', type: 'VECTOR', name: 'Star Icon', fills: [{ type: 'SOLID', color: { r: 1, g: 0.8, b: 0, a: 1 } }], ...box(16, 16, 24, 24) },
      { id: '1:3', type: 'FRAME', name: 'Hero', cornerRadius: 12, clipsContent: false, ...box(16, 56, 358, 80),
        fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], gradientStops: [stop(0, 1, 0, 0), stop(1, 0, 0, 1)] }] },
      { id: '1:4', type: 'FRAME', name: 'Glow', ...box(16, 150, 100, 100),
        fills: [{ type: 'GRADIENT_RADIAL', gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }], gradientStops: [stop(0, 1, 1, 1), stop(1, 0, 0, 0)] }] },
      { id: '1:5', type: 'FRAME', name: 'Clipped Card', cornerRadius: 8, clipsContent: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], ...box(130, 150, 100, 100) },
      { id: '1:6', type: 'FRAME', name: 'Conic', fills: [{ type: 'GRADIENT_ANGULAR', gradientStops: [stop(0, 1, 0, 0), stop(1, 0, 1, 0)] }],
        effects: [{ type: 'INNER_SHADOW', radius: 4, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 1 } }], ...box(250, 150, 100, 100) },
      { id: '1:7', type: 'TEXT', name: 'Promo Text', characters: 'Gói 5G giá tốt', ...box(16, 270, 358, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, textAutoResize: 'HEIGHT' },
        characterStyleOverrides: [0, 0, 0, 0, 1, 1], styleOverrideTable: { 1: { fontWeight: 700 } } },
      { id: '1:9', type: 'FRAME', name: 'Hot Tag', rectangleCornerRadii: [4, 4, 0, 4], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], ...box(16, 330, 40, 20) },
      { id: '1:10', type: 'FRAME', name: 'Sheet', rectangleCornerRadii: [16, 8, 0, 0], clipsContent: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], ...box(70, 330, 100, 60) },
      { id: '1:11', type: 'FRAME', name: 'Banner', cornerRadius: 12, fills: [{ type: 'IMAGE', imageRef: 'img-banner', scaleMode: 'FILL' }], ...box(16, 400, 358, 120),
        children: [{ id: '1:12', type: 'TEXT', name: 'Banner Title', characters: 'Data không giới hạn', fills: solid(1, 1, 1), style: { fontSize: 18, fontWeight: 700 }, ...box(32, 416, 200, 24) }] },
      { id: '1:13', type: 'FRAME', name: 'Ring', ...box(250, 400, 80, 40),
        fills: [{ type: 'GRADIENT_ANGULAR', gradientHandlePositions: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0 }, { x: 1, y: 0.5 }], gradientStops: [stop(0, 1, 0, 0), stop(1, 0, 0, 1)] }] },
      { id: '1:14', type: 'FRAME', name: 'Glass', cornerRadius: 16, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.4 } }],
        effects: [{ type: 'BACKGROUND_BLUR', radius: 20 }], ...box(16, 530, 170, 24) },
      { id: '1:15', type: 'FRAME', name: 'Soft', fills: solid(0.2, 0.6, 1), effects: [{ type: 'LAYER_BLUR', radius: 8 }], ...box(200, 530, 170, 24) },
      { id: '1:8', type: 'TEXT', name: 'Brand', characters: 'Viettel', ...box(16, 300, 100, 20), style: { fontFamily: 'Viettel Sans', fontSize: 14, fontWeight: 400 } }
    ]
  }
}

export const textStylingScreen = {
  root: {
    id: '1:1', type: 'FRAME', name: 'Promo', ...box(0, 0, 390, 400),
    children: [
      { id: '1:2', type: 'TEXT', name: 'Headline', characters: 'ưu đãi hôm nay', fills: solid(0, 0, 0), ...box(16, 16, 358, 44),
        style: { fontFamily: 'SF Pro', fontSize: 16, fontWeight: 600, lineHeightPx: 22, lineHeightUnit: 'PIXELS', letterSpacing: 0.5, textCase: 'UPPER', textAutoResize: 'HEIGHT', textAlignHorizontal: 'CENTER' } },
      { id: '1:3', type: 'TEXT', name: 'Terms', characters: 'Xem điều khoản', fills: solid(0, 0, 0), ...box(16, 70, 358, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, lineHeightPx: 17, lineHeightUnit: 'INTRINSIC_%', textAutoResize: 'HEIGHT' },
        characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        styleOverrideTable: { 1: { fills: solid(0, 0.4, 1), textDecoration: 'UNDERLINE' } } },
      { id: '1:4', type: 'TEXT', name: 'Old Price', characters: '50.000đ', fills: solid(0.5, 0.5, 0.5), ...box(16, 100, 80, 20),
        style: { fontFamily: 'SF Pro', fontSize: 14, fontWeight: 400, textDecoration: 'STRIKETHROUGH' } }
    ]
  }
}

// Màn hình dài hơn thiết bị (1400pt) → VC bọc UIScrollView, SwiftUI bọc ScrollView (P7).
export const longScreen = {
  root: {
    id: '5:1', type: 'FRAME', name: 'Long Feed', fills: solid(0.97, 0.97, 0.98), ...box(0, 0, 390, 1400),
    children: [
      text('5:2', 'Header', 16, 60, 358, 24, { constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' } }),
      { id: '5:3', type: 'FRAME', name: 'Card', cornerRadius: 12, fills: solid(1, 1, 1), constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' }, ...box(16, 100, 358, 600) },
      text('5:4', 'Footer', 16, 1340, 358, 24, { constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' } })
    ]
  }
}
