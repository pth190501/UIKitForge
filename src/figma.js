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
  if (!pathMatch) {
    throw new Error('Could not find the Figma file key in this URL.')
  }

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

  let response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'X-Figma-Token': token.trim()
      }
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
    if (response.status === 403) {
      throw new Error(`Figma denied access. Check token scope (file_content:read) and file permission${suffix}`)
    }
    if (response.status === 404) {
      throw new Error(`Figma file/node was not found or is not visible to this token${suffix}`)
    }
    if (response.status === 429) {
      throw new Error(`Figma API rate limit reached${suffix}`)
    }
    throw new Error(`Figma API returned HTTP ${response.status}${suffix}`)
  }

  const payload = await response.json()
  const root = extractRootNode(payload, parsed.nodeId)
  if (!root) throw new Error('Figma returned data, but UIKitForge could not find the requested node.')

  return {
    source: parsed,
    name: payload.name || root.name || 'Figma Selection',
    root,
    components: payload.components || {},
    componentSets: payload.componentSets || {},
    styles: payload.styles || {},
    raw: payload
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
  for (const child of node.children || []) {
    walkFigma(child, visitor, node, depth + 1)
  }
}

export function summarizeFigmaTree(root) {
  const counts = {}
  let nodes = 0
  let maxDepth = 0
  let instances = 0
  let components = 0

  walkFigma(root, (node, _parent, depth) => {
    nodes += 1
    maxDepth = Math.max(maxDepth, depth)
    counts[node.type] = (counts[node.type] || 0) + 1
    if (node.type === 'INSTANCE') instances += 1
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') components += 1
  })

  return { nodes, maxDepth, instances, components, counts }
}

export function findComponentCandidates(root) {
  const byComponentId = new Map()
  const explicitComponents = []

  walkFigma(root, node => {
    if (node.type === 'COMPONENT') explicitComponents.push(node)
    if (node.type === 'INSTANCE' && node.componentId && !byComponentId.has(node.componentId)) {
      byComponentId.set(node.componentId, node)
    }
  })

  return {
    explicitComponents,
    instances: [...byComponentId.entries()].map(([componentId, node]) => ({ componentId, node }))
  }
}

export function figmaPaintToCss(paint) {
  if (!paint || paint.visible === false) return null
  if (paint.type === 'SOLID' && paint.color) {
    const { r = 0, g = 0, b = 0, a = 1 } = paint.color
    const alpha = paint.opacity == null ? a : a * paint.opacity
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(alpha.toFixed(3))})`
  }
  return null
}

export function firstVisibleSolidPaint(paints = []) {
  return paints.find(paint => paint?.visible !== false && paint?.type === 'SOLID') || null
}
