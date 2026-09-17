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
