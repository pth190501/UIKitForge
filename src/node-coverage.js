// Deterministic structural coverage report. A represented node is not a
// pixel-perfect result; screenshots, assets, runtime behaviour and build
// validation remain separate release gates.
export function auditFigmaNodeCoverage(compiled, figmaData = {}) {
  const root = compiled?.sourceRoot || figmaData.root
  if (!root) throw new Error('Figma node coverage requires a source root')
  const irById = new Map()
  const collect = (node, owner) => {
    if (!node) return
    if (node.figmaId) irById.set(String(node.figmaId), { node, owner })
    for (const child of node.children || []) collect(child, owner)
  }
  collect(compiled.previewRoot, compiled.rootClass)
  for (const component of compiled.componentIRs || []) collect(component.ir, component.className)

  const rows = []
  const assetIssues = []
  const imageMap = figmaData.imageMap || {}
  const exported = figmaData.nodeImageExports || {}
  const hasExport = id => Boolean(exported[id]?.['2x'] || exported[id]?.['3x'])
  const hasImage = ref => Boolean(imageMap[ref])

  const walk = (node, parentId = null, inherited = null, depth = 0) => {
    if (!node) return
    const id = String(node.id || '')
    const entry = irById.get(id)
    let status = 'missing'
    let via = null
    let next = inherited

    if (node.visible === false || inherited?.status === 'hidden') {
      status = 'hidden'
      next = { status: 'hidden', id }
    } else if (inherited?.status === 'inside-component' || inherited?.status === 'inside-raster') {
      status = inherited.status
      via = inherited.id
    } else if (entry) {
      status = 'compiled'
      via = entry.owner
      if (entry.node.kind === 'component') {
        next = { status: 'inside-component', id }
      } else if (entry.node.meta?.rasterized) {
        status = 'rasterized'
        next = { status: 'inside-raster', id }
        if (!hasExport(id)) assetIssues.push({ nodeId: id, issue: 'raster image export not resolved' })
      }
      const imageFill = (node.fills || []).find(fill => fill?.visible !== false && fill.type === 'IMAGE' && fill.imageRef)
      if (imageFill && !hasImage(imageFill.imageRef) && !hasExport(id)) {
        assetIssues.push({ nodeId: id, issue: 'image fill not resolved' })
      }
    }
    rows.push({ nodeId: id, parentId, depth, name: String(node.name || ''), type: String(node.type || ''), status, via })
    for (const child of node.children || []) walk(child, id, next, depth + 1)
  }
  walk(root)
  const statuses = ['compiled', 'rasterized', 'inside-component', 'inside-raster', 'hidden', 'missing']
  const counts = Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.status === status).length]))
  const missing = rows.filter(row => row.status === 'missing')
  return {
    schemaVersion: 1,
    rootNodeId: String(root.id || ''),
    rootClass: compiled.rootClass,
    status: missing.length || assetIssues.length ? 'INCOMPLETE' : 'GENERATED_UNVERIFIED',
    nativeScreenshotVerified: false,
    pixelPerfectVerified: false,
    totalNodes: rows.length,
    counts,
    missingNodeIds: missing.map(row => row.nodeId),
    assetIssues,
    nodes: rows
  }
}

export function nodeCoverageMarkdown(report) {
  const lines = [
    '# Figma node coverage',
    '',
    `- Root node: \`${report.rootNodeId}\``,
    `- Generated view: \`${report.rootClass}\``,
    `- Total nodes: ${report.totalNodes}`,
    `- Status: **${report.status}**`,
    '- Native UIKit screenshot: **NOT VERIFIED**',
    '- Pixel-perfect fidelity: **NOT VERIFIED**',
    '',
    'A node may be compiled directly, represented inside a reusable component, or rasterized.',
    'Coverage is structural accounting, not proof of visual or functional fidelity.',
    '',
    '## Breakdown',
    ''
  ]
  for (const [status, count] of Object.entries(report.counts)) lines.push(`- ${status}: ${count}`)
  lines.push('', '## Missing nodes', '')
  if (!report.missingNodeIds.length) lines.push('- None detected.')
  for (const row of report.nodes.filter(node => node.status === 'missing')) {
    lines.push(`- \`${row.nodeId}\` — ${row.name.replace(/[\r\n`]/g, ' ')} (${row.type})`)
  }
  lines.push('', '## Missing asset sources', '')
  if (!report.assetIssues.length) lines.push('- None detected in the supplied Figma payload.')
  for (const issue of report.assetIssues) lines.push(`- \`${issue.nodeId}\`: ${issue.issue}`)
  lines.push('', '## Release gates', '',
    '- [ ] Every visible node is accounted for.',
    '- [ ] Image and vector exports are available at required scales.',
    '- [ ] Swift typecheck, XIB ibtool, and Auto Layout checks pass.',
    '- [ ] Dynamic 0/1/N items, interactions and scrolling are tested.',
    '- [ ] Real UIKit screenshots are compared against Figma at matching scale.',
    '- [ ] All differences are fixed or explicitly documented.',
    '')
  return lines.join('\n')
}

// Audit the real per-mode ZIP manifests: shared files and configs may collide
// with mode-specific files even when their declared targets are different.
export function auditExportPaths(files = [], swiftUIFiles = []) {
  const collisions = []
  const unsafe = []
  const normalize = file => String(file.path || '').replaceAll('\\', '/')
  const check = file => {
    const path = normalize(file)
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) {
      unsafe.push({ target: file.target || 'shared', path })
    }
  }
  for (const file of [...files, ...swiftUIFiles]) check(file)

  const configs = files.filter(file => file.kind === 'config')
  const variants = [
    ['uikit-xib', [...files.filter(file => file.target === 'uikit-xib' || file.target === 'uikit'), ...configs]],
    ['uikit-code', [
      ...files.filter(file => file.target === 'uikit-code' || file.target === 'uikit')
        .map(file => file.target === 'uikit' ? { ...file, path: `UIKit-Code/${file.path}` } : file),
      ...configs
    ]],
    ['swiftui', [...swiftUIFiles, ...configs]]
  ]
  for (const [target, manifest] of variants) {
    const seen = new Set()
    for (const file of manifest) {
      const path = normalize(file)
      const key = path.toLowerCase()
      if (seen.has(key)) collisions.push({ target, path })
      seen.add(key)
    }
  }
  return { ok: collisions.length === 0 && unsafe.length === 0, collisions, unsafe }
}
