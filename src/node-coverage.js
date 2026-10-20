import { internalKey } from './compiler-core.js'

export function auditFigmaNodeCoverage(compiled, figmaData = {}) {
  const root = compiled?.sourceRoot || figmaData.root
  if (!root) throw new Error('Figma node coverage requires a source root')

  const irById = new Map()
  const indexIR = (node, owner) => {
    if (!node) return
    if (node.figmaId) irById.set(String(node.figmaId), { node, owner })
    for (const child of node.children || []) indexIR(child, owner)
  }
  indexIR(compiled.previewRoot, compiled.rootClass)
  for (const component of compiled.componentIRs || []) indexIR(component.ir, component.className)

  const componentSourceIds = new Map((compiled.components || []).map(component => [component.className, component.sourceId]))
  const componentKeysByClass = new Map()
  for (const component of compiled.componentIRs || []) {
    const sourceId = componentSourceIds.get(component.className)
    if (!sourceId) continue
    const keys = new Set()
    const collectKeys = node => {
      const key = internalKey(node.figmaId, sourceId) || String(node.figmaId || '')
      if (key) keys.add(key)
      for (const child of node.children || []) collectKeys(child)
    }
    collectKeys(component.ir)
    componentKeysByClass.set(component.className, keys)
  }

  const rows = []
  const assetIssues = []
  const assetIssueKeys = new Set()
  const addAssetIssue = (nodeId, issue) => {
    const key = `${nodeId}\u0000${issue}`
    if (assetIssueKeys.has(key)) return
    assetIssueKeys.add(key)
    assetIssues.push({ nodeId, issue })
  }
  const imageMap = figmaData.imageMap || {}
  const exported = figmaData.nodeImageExports || {}
  const hasExport = id => Boolean(exported[id]?.['2x'] || exported[id]?.['3x'])
  const hasImage = ref => Boolean(imageMap[ref])

  const walk = (node, parentId = null, inherited = null, depth = 0, isRoot = false) => {
    if (!node) return
    const id = String(node.id || '')
    const entry = irById.get(id)
    let status = 'missing'
    let via = null
    let next = inherited
    const hidden = (!isRoot && node.visible === false) || inherited?.status === 'hidden'
    const insideRaster = inherited?.status === 'inside-raster'

    if (hidden) {
      status = 'hidden'
      next = { status: 'hidden', id }
    } else if (inherited?.status === 'inside-raster') {
      status = 'inside-raster'
      via = inherited.id
    } else if (inherited?.status === 'inside-component') {
      const key = internalKey(id, inherited.instanceId)
      const represented = key && componentKeysByClass.get(inherited.componentClass)?.has(key)
      if (represented) {
        status = 'inside-component'
        via = inherited.id
        if (entry?.node.meta?.rasterized) {
          status = 'rasterized'
          next = { status: 'inside-raster', id }
        } else if (entry?.node.kind === 'component') {
          next = { status: 'inside-component', id, componentClass: entry.node.className, instanceId: id }
        }
      }
    } else if (entry) {
      status = 'compiled'
      via = entry.owner
      if (entry.node.meta?.rasterized) {
        status = 'rasterized'
        next = { status: 'inside-raster', id }
      } else if (entry.node.kind === 'component') {
        next = { status: 'inside-component', id, componentClass: entry.node.className, instanceId: id }
      }
    }

    if (!hidden && !insideRaster && entry?.node.meta?.rasterized && !hasExport(id)) {
      addAssetIssue(id, 'raster image export URL not resolved')
    }
    if (!hidden && !insideRaster) {
      for (const fill of (node.fills || []).filter(item => item?.visible !== false && item.type === 'IMAGE')) {
        if (!hasImage(fill.imageRef) && !hasExport(id)) addAssetIssue(id, 'image fill URL not resolved')
      }
    }

    rows.push({ nodeId: id, parentId, depth, name: String(node.name || ''), type: String(node.type || ''), status, via })
    for (const child of node.children || []) walk(child, id, next, depth + 1)
  }
  walk(root, null, null, 0, true)

  const counts = Object.fromEntries(['compiled', 'rasterized', 'inside-component', 'inside-raster', 'hidden', 'missing'].map(status => [status, 0]))
  for (const row of rows) counts[row.status]++
  const missingNodeIds = rows.filter(row => row.status === 'missing').map(row => row.nodeId)
  const imageExportWarnings = figmaData.assetExportWarning ? [figmaData.assetExportWarning] : []
  return {
    schemaVersion: 1,
    rootNodeId: String(root.id || ''),
    rootClass: compiled.rootClass,
    status: missingNodeIds.length || assetIssues.length || imageExportWarnings.length ? 'INCOMPLETE' : 'GENERATED_UNVERIFIED',
    totalNodes: rows.length,
    counts,
    missingNodeIds,
    assetIssues,
    imageExportWarnings,
    nativeScreenshotVerified: false,
    pixelPerfectVerified: false,
    nodes: rows
  }
}

export function nodeCoverageMarkdown(report) {
  const markdownText = value => String(value ?? '')
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, '\\$&')
  const lines = [
    '# Figma node coverage',
    '',
    `- Root node: \`${markdownText(report.rootNodeId)}\``,
    `- Generated view: \`${markdownText(report.rootClass)}\``,
    `- Total nodes: ${report.totalNodes}`,
    `- Overall status: **${report.overallStatus || report.status}**`,
    `- Structural status: **${report.status}**`,
    '- Binary image download results are recorded in `UIKitForge.generated.json` after ZIP export.',
    '- Native UIKit screenshot: **NOT VERIFIED**',
    '- Pixel-perfect fidelity: **NOT VERIFIED**',
    '',
    'A node may be compiled directly, represented inside a reusable component, or rasterized.',
    'Structural accounting does not prove visual or functional fidelity.',
    '',
    '## Breakdown',
    ''
  ]
  for (const [status, count] of Object.entries(report.counts)) lines.push(`- ${status}: ${count}`)
  lines.push('', '## Missing nodes', '')
  if (!report.missingNodeIds.length) lines.push('- None detected.')
  for (const row of report.nodes.filter(node => node.status === 'missing')) {
    lines.push(`- \`${markdownText(row.nodeId)}\` — ${markdownText(row.name)} (${markdownText(row.type)})`)
  }
  lines.push('', '## Unresolved asset sources', '')
  if (!report.assetIssues.length) lines.push('- None detected in the supplied Figma payload.')
  for (const issue of report.assetIssues) lines.push(`- \`${markdownText(issue.nodeId)}\`: ${markdownText(issue.issue)}`)
  if (report.imageExportWarnings?.length) {
    lines.push('', '## Figma image export warnings', '')
    for (const warning of report.imageExportWarnings) lines.push(`- ${markdownText(warning)}`)
  }
  if (report.binaryAssetDownloadWarnings?.length) {
    lines.push('', '## Binary asset download warnings', '')
    for (const warning of report.binaryAssetDownloadWarnings) lines.push(`- ${markdownText(warning)}`)
  }
  lines.push('', '## Release gates', '',
    '- [ ] Every visible node is accounted for.',
    '- [ ] Image and vector exports are available at required scales.',
    '- [ ] Swift typecheck, XIB ibtool, and Auto Layout checks pass.',
    '- [ ] Dynamic 0/1/N items, interactions and scrolling are tested.',
    '- [ ] Real UIKit screenshots are compared against Figma at matching scale.',
    '- [ ] All differences are fixed or explicitly documented.',
    '')
  return lines.join('\n') + '\n'
}

// Kiểm tra đường dẫn riêng cho từng kiểu ZIP trước khi đưa file vào gói xuất.
export function auditExportPaths(files = [], swiftUIFiles = [], androidFiles = []) {
  const collisions = []
  const unsafe = []
  const pathOf = file => String(file.path || '').replaceAll('\\', '/')
  const check = file => {
    const path = pathOf(file)
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      unsafe.push({ target: file.target || 'shared', path })
    }
  }
  for (const file of [...files, ...swiftUIFiles, ...androidFiles]) check(file)

  const configs = files.filter(file => file.kind === 'config')
  const variants = [
    ['uikit-xib', [...files.filter(file => file.target === 'uikit-xib' || file.target === 'uikit'), ...configs]],
    ['uikit-code', [
      ...files.filter(file => file.target === 'uikit-code' || file.target === 'uikit')
        .map(file => file.target === 'uikit' ? { ...file, path: `UIKit-Code/${file.path}` } : file),
      ...configs
    ]],
    ['swiftui', [...swiftUIFiles, ...configs]],
    ['android-compose', [...androidFiles, ...configs]]
  ]
  for (const [target, manifest] of variants) {
    const seen = new Set()
    for (const file of manifest) {
      const path = pathOf(file)
      const key = path.toLowerCase()
      if (seen.has(key)) collisions.push({ target, path })
      seen.add(key)
    }
  }
  return { ok: collisions.length === 0 && unsafe.length === 0, collisions, unsafe }
}
