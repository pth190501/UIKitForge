const FIGMA_API = 'https://api.figma.com/v1'

export function parseFigmaUrl(rawUrl) {
  if (!rawUrl?.trim()) throw new Error('Please paste a Figma URL.')

  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('Invalid Figma URL.')
  }

  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') throw new Error('Figma URLs must use HTTPS.')
  if (hostname !== 'figma.com' && !hostname.endsWith('.figma.com')) {
    throw new Error('This is not a figma.com URL.')
  }

  const path = url.pathname.split('/').filter(Boolean)
  let fileKey
  if (path[0]?.toLowerCase() === 'community') {
    if (path[1]?.toLowerCase() !== 'file') throw new Error('This Figma community link does not point to a file.')
    fileKey = path[2]
  } else if (path[0]?.toLowerCase() === 'design' && path[2]?.toLowerCase() === 'branch') {
    fileKey = path[3]
  } else if (path[0]?.toLowerCase() !== 'files') {
    fileKey = path[1]
  }
  if (!fileKey) throw new Error('Could not find a Figma file key in this URL.')
  const rawNodeId = url.searchParams.get('node-id')
  const nodeId = rawNodeId ? normalizeNodeId(rawNodeId) : null

  return { fileKey, nodeId, url: url.toString() }
}

export function normalizeNodeId(nodeId) {
  if (!nodeId) return null
  let decoded
  try {
    decoded = decodeURIComponent(nodeId)
  } catch {
    throw new Error('Invalid Figma node ID.')
  }
  if (decoded.includes(':')) return decoded
  return decoded.replace(/-/g, ':')
}

export async function fetchFigmaSelection({ figmaUrl, token, nodeId: requestedNodeId = null }) {
  if (!token?.trim()) throw new Error('Please enter a Figma Personal Access Token.')

  const parsed = parseFigmaUrl(figmaUrl)
  const nodeId = requestedNodeId ? normalizeNodeId(requestedNodeId) : parsed.nodeId
  const indexOnly = !nodeId
  // Dùng depth nông để chọn mục tiêu; tải node đã chọn không giới hạn chiều sâu theo API.
  // Nguồn: https://developers.figma.com/docs/rest-api/file-endpoints/
  const endpoint = nodeId
    ? `${FIGMA_API}/files/${encodeURIComponent(parsed.fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
    : `${FIGMA_API}/files/${encodeURIComponent(parsed.fileKey)}?depth=3`

  const payload = await figmaGet(endpoint, token)
  const root = extractRootNode(payload, nodeId)
  if (!root) throw new Error('Figma returned data, but UIKitForge could not find the requested node.')

  const nodeEntries = Object.values(payload.nodes || {}).filter(Boolean)
  const selection = {
    source: { ...parsed, nodeId },
    name: payload.name || root.name || 'Figma Selection',
    root,
    components: Object.assign({}, payload.components, ...nodeEntries.map(entry => entry.components || {})),
    componentSets: Object.assign({}, payload.componentSets, ...nodeEntries.map(entry => entry.componentSets || {})),
    // /nodes trả styles trong từng node; /files trả styles ở cấp response.
    styles: Object.assign({}, payload.styles, ...nodeEntries.map(entry => entry.styles || {})),
    raw: payload,
    indexOnly
  }

  if (indexOnly) {
    return {
      ...selection,
      imageMap: {},
      imageFillWarning: null,
      nodeImageExports: {},
      assetExportWarning: null
    }
  }

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
    ...selection,
    imageMap,
    imageFillWarning,
    nodeImageExports,
    assetExportWarning
  }
}

// Chia node ID thành nhóm có giới hạn cho endpoint export ảnh Figma.
export function batchFigmaNodeIds(ids, batchSize = 20) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 20
  const batches = []
  for (let index = 0; index < unique.length; index += size) batches.push(unique.slice(index, index + size))
  return batches
}

export async function fetchNodeImageExports(fileKey, root, token) {
  const nodeIds = [...new Set(collectRasterAssetNodeIds(root).filter(Boolean))]
  if (!nodeIds.length) return { nodeImageExports: {}, assetExportWarning: null }

  const nodeImageExports = {}
  const failures = []
  const batches = batchFigmaNodeIds(nodeIds)

  // Hai batch cùng lúc; mỗi batch giữ kết quả thành công riêng ở cả hai scale.
  async function processBatch(batch, batchIndex) {
    const results = await Promise.allSettled([2, 3].map(scale =>
      figmaGet(`${FIGMA_API}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(batch.join(','))}&scale=${scale}&format=png`, token)
    ))
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      const scale = index === 0 ? '2x' : '3x'
      if (result.status === 'rejected') {
        failures.push(`Batch ${batchIndex + 1}/${batches.length} @${scale} request failed: ${result.reason?.message || 'unknown error'}`)
        continue
      }
      for (const id of batch) {
        const url = result.value?.images?.[id]
        if (!url) continue
        if (!nodeImageExports[id]) nodeImageExports[id] = { '2x': null, '3x': null }
        nodeImageExports[id][scale] = url
      }
    }
  }

  // Giới hạn request song song để file nhiều vector không tạo URL ảnh quá dài hoặc dồn tải vào Figma.
  for (let index = 0; index < batches.length; index += 2) {
    await Promise.all(batches.slice(index, index + 2).map((batch, offset) => processBatch(batch, index + offset)))
  }

  const missing = nodeIds.filter(id => !nodeImageExports[id])
  const partial = nodeIds.filter(id => nodeImageExports[id] && (!nodeImageExports[id]['2x'] || !nodeImageExports[id]['3x']))
  const issues = [
    ...failures.slice(0, 3),
    missing.length ? `${missing.length} node(s) have no render URL.` : null,
    partial.length ? `${partial.length} node(s) have only one export scale.` : null
  ].filter(Boolean)
  const resolved = nodeIds.length - missing.length
  const assetExportWarning = issues.length
    ? `Image export incomplete: ${resolved}/${nodeIds.length} nodes resolved. ${issues.join(' ')}${failures.length > 3 ? ` (+${failures.length - 3} more failed requests)` : ''}`
    : null
  return { nodeImageExports, assetExportWarning }
}

function collectRasterAssetNodeIds(root) {
  const ids = []
  const visit = node => {
    if (!node || node.visible === false) return
    // Node mới, vector, icon hoặc hình xoay được xuất nguyên cụm thành ảnh — không đi vào con nữa.
    if (isRasterCandidate(node)) { ids.push(node.id); return }
    const hasNoRenderableChildren = !(node.children || []).some(child => child.visible !== false)
    if (hasNoRenderableChildren && (node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE' && fill.imageRef)) ids.push(node.id)
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return ids
}

// ---- Node khó dựng bằng UIKit/SwiftUI thuần → xuất ảnh từ Figma (PNG @2x/@3x) và dùng thẳng trong code ----
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'REGULAR_POLYGON', 'LINE'])
const SHAPE_TYPES = new Set(['ELLIPSE', 'RECTANGLE'])
const WRAPPER_TYPES = new Set(['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT'])
export const VIEW_TYPES = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT',
  'RECTANGLE', 'ELLIPSE', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'REGULAR_POLYGON', 'LINE'
])

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
  // Leaf type mới chưa có renderer: raster hóa để giữ hình thay vì bỏ node.
  if (node.type && !VIEW_TYPES.has(node.type) && !['DOCUMENT', 'CANVAS'].includes(node.type) && !visibleChildren(node).length) return true
  // UIView xoay được nhưng Auto Layout tính theo khung chưa xoay → hình xoay (không chứa text) xuất ảnh cho đúng thiết kế.
  return Math.abs(Number(node.rotation) || 0) > 0.5 && !containsText(node) && !hasImagePaint(node)
}

const RETRYABLE_FIGMA_STATUSES = new Set([429, 502, 503, 504])
const MAX_FIGMA_RETRIES = 2

function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('Retry-After')
  const retrySeconds = Number(header)
  if (header && Number.isFinite(retrySeconds) && retrySeconds >= 0) {
    return Math.min(5000, Math.round(retrySeconds * 1000))
  }
  return Math.min(2000, 300 * (2 ** attempt))
}

export async function figmaGet(endpoint, token) {
  for (let attempt = 0; attempt <= MAX_FIGMA_RETRIES; attempt++) {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'X-Figma-Token': token.trim() }
      })
    } catch (error) {
      if (attempt < MAX_FIGMA_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 300 * (2 ** attempt)))
        continue
      }
      throw new Error(`Could not reach the Figma API from this browser. ${error?.message || ''}`.trim())
    }

    if (response.ok) return response.json()

    if (RETRYABLE_FIGMA_STATUSES.has(response.status) && attempt < MAX_FIGMA_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)))
      continue
    }

    let detail = ''
    try {
      const body = await response.json()
      detail = body?.err || body?.message || JSON.stringify(body)
    } catch {
      try { detail = await response.text() } catch { detail = '' }
    }

    const suffix = detail ? ` — ${detail}` : ''
    if (response.status === 403) {
      throw new Error(`Figma denied access. Check token scope (file_content:read) and file permission${suffix}`)
    }
    if (response.status === 404) throw new Error(`Figma file/node was not found or is not visible to this token${suffix}`)
    if (response.status === 429) throw new Error(`Figma API rate limit reached after retries${suffix}`)
    throw new Error(`Figma API returned HTTP ${response.status}${suffix}`)
  }
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
