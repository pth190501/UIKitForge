const FIGMA_API = 'https://api.figma.com/v1'

export function parseFigmaUrl(rawUrl) {
  if (!rawUrl?.trim()) throw new Error('Please paste a Figma URL.')

  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('Invalid Figma URL.')
  }

  if (!/figma\.com$/i.test(url.hostname) && !/\.figma\.com$/i.test(url.hostname)) {
    throw new Error('This is not a figma.com URL.')
  }

  const pathMatch = url.pathname.match(/\/(?:design|file|proto)\/([^/]+)/i)
  if (!pathMatch) throw new Error('Could not find the Figma file key in this URL.')

  const fileKey = pathMatch[1]
  const rawNodeId = url.searchParams.get('node-id')
  const nodeId = rawNodeId ? normalizeNodeId(rawNodeId) : null

  return { fileKey, nodeId, url: url.toString() }
}

export function normalizeNodeId(nodeId) {
  if (!nodeId) return null
  const decoded = decodeURIComponent(nodeId)
  if (decoded.includes(':')) return decoded
  return decoded.replace(/-/g, ':')
}

export async function fetchFigmaSelection({ figmaUrl, token }) {
  if (!token?.trim()) throw new Error('Please enter a Figma Personal Access Token.')

  const parsed = parseFigmaUrl(figmaUrl)
  const endpoint = parsed.nodeId
    ? `${FIGMA_API}/files/${encodeURIComponent(parsed.fileKey)}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`
    : `${FIGMA_API}/files/${encodeURIComponent(parsed.fileKey)}?depth=8`

  const payload = await figmaGet(endpoint, token)
  const root = extractRootNode(payload, parsed.nodeId)
  if (!root) throw new Error('Figma returned data, but UIKitForge could not find the requested node.')

  const imageRefs = collectImageRefs(root)
  let imageMap = {}
  let imageFillWarning = null

  if (imageRefs.length) {
    try {
      const imagePayload = await figmaGet(`${FIGMA_API}/files/${encodeURIComponent(parsed.fileKey)}/images`, token)
      const allImages = imagePayload?.images || {}
      imageMap = Object.fromEntries(imageRefs.map(ref => [ref, allImages[ref]]).filter(([, url]) => Boolean(url)))
    } catch (error) {
      imageFillWarning = `Image fills could not be resolved for browser preview: ${error?.message || 'unknown error'}`
    }
  }

  const { nodeImageExports, assetExportWarning } = await fetchNodeImageExports(parsed.fileKey, root, token)

  return {
    source: parsed,
    name: payload.name || root.name || 'Figma Selection',
    root,
    components: payload.components || {},
    componentSets: payload.componentSets || {},
    styles: payload.styles || {},
    imageMap,
    imageFillWarning,
    nodeImageExports,
    assetExportWarning,
    raw: payload
  }
}

// Render PNG @2x/@3x cho từng node có IMAGE fill trực tiếp (không có con) — đây là đúng những node
// compiler phân loại kind:'image' (xem hasImageFill trong compiler-core.js). Khớp theo Figma node id;
// main.js sẽ nối id này với outlet sau khi compile để đặt tên file trong Assets.xcassets.
async function fetchNodeImageExports(fileKey, root, token) {
  const nodeIds = collectImageFillNodeIds(root)
  if (!nodeIds.length) return { nodeImageExports: {}, assetExportWarning: null }

  try {
    const ids = nodeIds.join(',')
    const [png2x, png3x] = await Promise.all([
      figmaGet(`${FIGMA_API}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ids)}&scale=2&format=png`, token),
      figmaGet(`${FIGMA_API}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ids)}&scale=3&format=png`, token)
    ])
    const nodeImageExports = {}
    for (const id of nodeIds) {
      const url2x = png2x?.images?.[id]
      const url3x = png3x?.images?.[id]
      if (url2x || url3x) nodeImageExports[id] = { '2x': url2x || null, '3x': url3x || null }
    }
    return { nodeImageExports, assetExportWarning: null }
  } catch (error) {
    return { nodeImageExports: {}, assetExportWarning: `Image asset export (@2x/@3x) failed: ${error?.message || 'unknown error'}` }
  }
}

function collectImageFillNodeIds(root) {
  const ids = []
  const visit = (node, isRoot) => {
    if (!node || node.visible === false) return
    // Node phức tạp (vector/icon/hình xoay) xuất nguyên cụm thành 1 ảnh — không đi vào con nữa.
    if (!isRoot && isRasterCandidate(node)) { ids.push(node.id); return }
    const hasNoRenderableChildren = !(node.children || []).some(child => child.visible !== false)
    if (hasNoRenderableChildren && (node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE' && fill.imageRef)) ids.push(node.id)
    for (const child of node.children || []) visit(child, false)
  }
  visit(root, true)
  return ids
}

// ---- Node khó dựng bằng UIKit/SwiftUI thuần → xuất ảnh từ Figma (PNG @2x/@3x) và dùng thẳng trong code ----
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'REGULAR_POLYGON', 'LINE'])
const SHAPE_TYPES = new Set(['ELLIPSE', 'RECTANGLE'])
const WRAPPER_TYPES = new Set(['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT'])

function visibleChildren(node) {
  return (node.children || []).filter(child => child.visible !== false)
}

function hasImagePaint(node) {
  return (node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE')
}

// Cả cây con chỉ gồm vector/hình khối/khung bọc (không text, không ảnh) — tức là một icon/hình minh hoạ.
function isGraphicOnly(node) {
  if (node.type === 'TEXT' || hasImagePaint(node)) return false
  if (!VECTOR_TYPES.has(node.type) && !SHAPE_TYPES.has(node.type) && !WRAPPER_TYPES.has(node.type)) return false
  return visibleChildren(node).every(isGraphicOnly)
}

function containsVector(node) {
  return VECTOR_TYPES.has(node.type) || visibleChildren(node).some(containsVector)
}

function containsText(node) {
  return node.type === 'TEXT' || visibleChildren(node).some(containsText)
}

export function isRasterCandidate(node) {
  if (!node || node.visible === false || node.type === 'TEXT') return false
  if (VECTOR_TYPES.has(node.type)) return true
  if (visibleChildren(node).length && isGraphicOnly(node) && containsVector(node)) return true
  // UIView xoay được nhưng Auto Layout tính theo khung chưa xoay → hình xoay (không chứa text) xuất ảnh cho đúng thiết kế.
  return Math.abs(Number(node.rotation) || 0) > 0.5 && !containsText(node) && !hasImagePaint(node)
}

async function figmaGet(endpoint, token) {
  let response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: { 'X-Figma-Token': token.trim() }
    })
  } catch (error) {
    throw new Error(`Could not reach the Figma API from this browser. ${error?.message || ''}`.trim())
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.err || body?.message || JSON.stringify(body)
    } catch {
      detail = await response.text()
    }

    const suffix = detail ? ` — ${detail}` : ''
    if (response.status === 403) throw new Error(`Figma denied access. Check token scope (file_content:read) and file permission${suffix}`)
    if (response.status === 404) throw new Error(`Figma file/node was not found or is not visible to this token${suffix}`)
    if (response.status === 429) throw new Error(`Figma API rate limit reached${suffix}`)
    throw new Error(`Figma API returned HTTP ${response.status}${suffix}`)
  }

  return response.json()
}

function extractRootNode(payload, nodeId) {
  if (nodeId) {
    const direct = payload?.nodes?.[nodeId]?.document
    if (direct) return direct

    const normalizedKey = Object.keys(payload?.nodes || {}).find(
      key => normalizeNodeId(key) === normalizeNodeId(nodeId)
    )
    if (normalizedKey) return payload.nodes[normalizedKey]?.document || null
    return null
  }
  return payload?.document || null
}

export function walkFigma(node, visitor, parent = null, depth = 0) {
  if (!node) return
  visitor(node, parent, depth)
  for (const child of node.children || []) walkFigma(child, visitor, node, depth + 1)
}

export function summarizeFigmaTree(root) {
  const counts = {}
  let nodes = 0
  let maxDepth = 0
  let instances = 0
  let components = 0
  let images = 0

  walkFigma(root, (node, _parent, depth) => {
    nodes += 1
    maxDepth = Math.max(maxDepth, depth)
    counts[node.type] = (counts[node.type] || 0) + 1
    if (node.type === 'INSTANCE') instances += 1
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') components += 1
    if ((node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE')) images += 1
  })

  return { nodes, maxDepth, instances, components, images, counts }
}

function countVisible(node) {
  if (!node || node.visible === false) return 0
  return 1 + (node.children || []).reduce((sum, child) => sum + countVisible(child), 0)
}

export function findComponentCandidates(root) {
  const byComponentId = new Map()
  const allInstances = new Map()
  const explicitComponents = []

  // Bỏ cả nhánh đang ẩn (visible:false): compiler không vẽ chúng, nên sinh class component cho chúng
  // chỉ tạo file thừa trong ZIP (vd nút Ellipsis ẩn trong header).
  // Root luôn được duyệt kể cả khi đang ẩn — user có thể trỏ URL thẳng vào 1 node ẩn và compiler vẫn dựng nó.
  const visit = (node, isRoot = false) => {
    if (!node || (!isRoot && node.visible === false)) return
    if (node.type === 'COMPONENT') explicitComponents.push(node)
    if (node.type === 'INSTANCE' && node.componentId) {
      if (!allInstances.has(node.componentId)) allInstances.set(node.componentId, [])
      allInstances.get(node.componentId).push(node)
      // Instance làm gốc cho class component: chọn cái có nhiều node đang hiển thị nhất, để phần tử bị ẩn ở vài
      // instance (vd nhãn "Hot") vẫn có trong class và còn bật/tắt được qua configure.
      const current = byComponentId.get(node.componentId)
      if (!current || countVisible(node) > countVisible(current)) byComponentId.set(node.componentId, node)
    }
    for (const child of node.children || []) visit(child)
  }
  visit(root, true)

  return {
    explicitComponents,
    instances: [...byComponentId.entries()].map(([componentId, node]) => ({ componentId, node, all: allInstances.get(componentId) }))
  }
}

export function collectImageRefs(root) {
  const refs = new Set()
  walkFigma(root, node => {
    for (const paint of node.fills || []) {
      if (paint?.visible !== false && paint?.type === 'IMAGE' && paint.imageRef) refs.add(paint.imageRef)
    }
  })
  return [...refs]
}

export function figmaPaintToCss(paint) {
  if (!paint || paint.visible === false) return null

  if (paint.type === 'SOLID' && paint.color) return colorToCss(paint.color, paint.opacity)

  if (paint.type?.startsWith('GRADIENT_') && Array.isArray(paint.gradientStops) && paint.gradientStops.length) {
    const stops = paint.gradientStops
      .map(stop => `${colorToCss(stop.color, paint.opacity)} ${Math.round((stop.position || 0) * 10000) / 100}%`)
      .join(', ')

    if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
      return `radial-gradient(circle, ${stops})`
    }

    if (paint.type === 'GRADIENT_ANGULAR') {
      // CSS conic: 0deg ở hướng 12 giờ; handle Figma (tâm → hướng bắt đầu) đo từ hướng 3 giờ → cộng 90°.
      const [center, direction] = paint.gradientHandlePositions || []
      if (!center || !direction) return `conic-gradient(from 0deg, ${stops})`
      const from = Math.atan2(direction.y - center.y, direction.x - center.x) * 180 / Math.PI + 90
      return `conic-gradient(from ${Number(from.toFixed(2))}deg at ${Number((center.x * 100).toFixed(2))}% ${Number((center.y * 100).toFixed(2))}%, ${stops})`
    }

    const handles = paint.gradientHandlePositions || []
    const start = handles[0]
    const end = handles[1]
    const angle = start && end
      ? Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI + 90
      : 180
    return `linear-gradient(${Number(angle.toFixed(2))}deg, ${stops})`
  }

  return null
}

export function firstVisibleSolidPaint(paints = []) {
  return paints.find(paint => paint?.visible !== false && paint?.type === 'SOLID') || null
}

export function firstVisiblePaint(paints = []) {
  return paints.find(paint => paint?.visible !== false) || null
}

function colorToCss(color, opacity = null) {
  const { r = 0, g = 0, b = 0, a = 1 } = color || {}
  const alpha = opacity == null ? a : a * opacity
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(alpha.toFixed(3))})`
}
