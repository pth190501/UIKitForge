import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { arrangedChildStyle, isArrangedChild, resolveStack, stackContainerStyle } from '../src/preview-layout.js'
import { feedSlotScreen } from './fixtures.mjs'

const root = compileUIKit(feedSlotScreen, 'GeneratedView', { deploymentTarget: 13 }).previewRoot
const find = outlet => {
  let found = null
  const walk = node => { if (!found && node.outlet === outlet) found = node; for (const child of node.children || []) walk(child) }
  walk(root)
  return found
}

// Root "Feed/ News": UIStackView dọc, spacing 12, padding 12 — thành flex column.
const rootStack = resolveStack(root)
assert.equal(rootStack.horizontal, false)
assert.equal(rootStack.spacing, 12)
assert.deepEqual(rootStack.padding, { top: 12, right: 12, bottom: 12, left: 12 })
assert.deepEqual(stackContainerStyle(rootStack), { display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px 12px 12px 12px', justifyContent: 'center', alignItems: 'stretch' })

// Label HUG: không được khoá cứng width/height của Figma (67×20) — đó là nguyên nhân "Emi bảo trì" bị cắt.
const content = find('content')
const contentStack = resolveStack(content)
assert.equal(contentStack.align, 'flex-start', 'content stack is leading-aligned')
const title = arrangedChildStyle(find('emiBaoTri'), contentStack)
assert.equal(title.width, 'auto')
assert.equal(title.height, 'auto')
assert.equal(title.position, 'relative')
assert.equal(arrangedChildStyle(find('view20042026'), contentStack).width, 'auto')

// FIXED giữ kích thước Figma; FILL chiếm phần còn lại theo trục chính.
const rowStack = resolveStack(find('stack'))
assert.equal(rowStack.horizontal, true)
assert.equal(rowStack.align, 'center')
const avatar = arrangedChildStyle(find('emiAvatar'), rowStack)
assert.equal(avatar.width, '40px')
assert.equal(avatar.height, '40px')
assert.equal(avatar.flex, '0 0 auto')
assert.equal(arrangedChildStyle(content, rowStack).flex, '1 1 0px', 'content FILLs the rest of the header row')

// Ảnh FILL ngang trong stack dọc fill → stretch, cao cố định 160.
const image = arrangedChildStyle(find('image2250'), rootStack)
assert.equal(image.alignSelf, 'stretch')
assert.equal(image.height, '160px')

// Dữ liệu Figma thô (previewChildren của component) cũng dựng được stack.
const raw = { layout: { mode: 'HORIZONTAL', itemSpacing: 8, primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER', paddingLeft: 4 } }
assert.deepEqual(resolveStack(raw), { horizontal: true, spacing: 0, padding: { top: 0, right: 0, bottom: 0, left: 4 }, justify: 'space-between', align: 'center' })
assert.equal(resolveStack({ layout: { mode: 'NONE' } }), null)
assert.equal(isArrangedChild({ meta: { layoutPositioning: 'ABSOLUTE' } }), false)
assert.equal(isArrangedChild({ meta: { layoutPositioning: 'AUTO' } }), true)
assert.equal(isArrangedChild({ arranged: false, meta: { layoutPositioning: 'AUTO' } }), false, 'IR flag wins over raw metadata')

// View thường HUG không có intrinsic size → giữ kích thước Figma thay vì co về 0.
const plainHug = arrangedChildStyle({ kind: 'view', frame: { width: 30, height: 10 }, sizing: { h: 'HUG', v: 'HUG' } }, rowStack)
assert.equal(plainHug.width, '30px')
assert.equal(plainHug.height, '10px')

console.log('✓ preview Auto Layout mapping (UIStackView → flexbox, HUG/FILL/FIXED) passed')
