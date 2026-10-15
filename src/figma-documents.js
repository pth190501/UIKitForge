function walk(node, visitor, parent = null, parentVisible = true) {
  if (!node) return
  const visible = parentVisible && node.visible !== false
  visitor(node, parent, visible, parentVisible)
  for (const child of node.children || []) walk(child, visitor, node, visible)
}

export function generateFigmaDocuments(figmaData, compiled) {
  const root = compiled.sourceRoot || figmaData.root
  const rawById = new Map()
  const records = []
  walk(root, (node, parent, visible, parentVisible) => {
    rawById.set(node.id, node)
    records.push({ node, parent, visible, parentVisible })
  })

  const irByFigmaId = new Map()
  const irOwnerByFigmaId = new Map()
  const indexIR = (ir, owner) => walk(ir, node => {
    irByFigmaId.set(node.figmaId, node)
    irOwnerByFigmaId.set(node.figmaId, owner)
  })
  indexIR(compiled.previewRoot, compiled.rootClass)
  for (const { ir, className } of compiled.componentIRs || []) indexIR(ir, className)
  const componentById = new Map((compiled.components || []).map(component => [component.componentId, component]))
  const sections = (root.children || []).map(section => sectionRow(section, root.visible !== false, irByFigmaId, componentById))
  const hiddenRoots = records.filter(item => item.node.visible === false && item.parentVisible)
  const visibleCount = records.filter(item => item.visible).length
  const variantRows = records.flatMap(({ node, visible }) => {
    if (!visible || node.type !== 'INSTANCE') return []
    return Object.entries(node.componentProperties || {})
      .filter(([, property]) => property?.type === 'VARIANT')
      .map(([name, property]) => ({ node, name, value: property.value }))
  })
  const reactions = records.flatMap(({ node, visible }) => visible
    ? (node.reactions || []).map(reaction => ({ node, reaction }))
    : [])
  const fonts = new Set()
  const spacing = new Set()
  let imageFills = 0
  walk(root, (node, _parent, visible) => {
    if (!visible) return
    if (node.type === 'TEXT' && node.style?.fontFamily) {
      const weight = node.style.fontWeight ? ` ${node.style.fontWeight}` : ''
      const size = node.style.fontSize ? ` ${node.style.fontSize}px` : ''
      fonts.add(`${node.style.fontFamily}${weight}${size}`)
    }
    if (node.layoutMode && node.layoutMode !== 'NONE') {
      for (const value of [node.itemSpacing, node.paddingLeft, node.paddingRight, node.paddingTop, node.paddingBottom]) {
        if (Number.isFinite(value) && value !== 0) spacing.add(Number(value))
      }
    }
    if ((node.fills || []).some(fill => fill?.visible !== false && fill?.type === 'IMAGE')) imageFills += 1
  })

  const source = figmaData.source || {}
  const figmaLink = source.fileKey && source.nodeId
    ? `https://www.figma.com/design/${encodeURIComponent(source.fileKey)}?node-id=${encodeURIComponent(String(source.nodeId).replace(/:/g, '-'))}`
    : null
  const componentLines = (compiled.components || []).map(component => {
    const sourceNode = rawById.get(component.sourceId)
    const properties = Object.entries(sourceNode?.componentProperties || {})
      .map(([name, property]) => `${name}: ${property?.type || 'property'}${property?.value == null ? '' : ` = ${property.value}`}`)
    const files = (compiled.files || [])
      .filter(file => file.kind === 'component' && file.name?.startsWith(`${component.className}.`))
      .map(file => `\`${file.path}\``)
    return `| ${md(component.sourceName)} | \`${md(component.sourceId)}\` | \`${md(component.componentId)}\` | \`${md(component.className)}\` | ${md(properties.join('; ') || 'No exposed instance properties')} | ${files.join(', ') || 'See selected output'} |`
  })
  const sectionLines = sections.map(section => `| ${md(section.name)} | \`${md(section.id)}\` | ${section.visible ? 'Visible' : 'Hidden'} | ${section.visibleNodes} | ${md(section.mapping)} | ${md(section.dynamic)} |`)
  const hiddenLines = hiddenRoots.map(({ node }) => `| ${md(node.name || node.type)} | \`${md(node.id)}\` | ${md(node.type)} |`)
  const variantLines = variantRows.map(({ node, name, value }) => `| ${md(node.name || node.type)} | \`${md(node.id)}\` | ${md(name)} | ${md(value)} |`)
  const reactionLines = reactions.map(({ node, reaction }) => {
    const trigger = reaction.trigger?.type || 'Unknown trigger'
    const actions = reaction.actions || (reaction.action ? [reaction.action] : [])
    const details = actions.map(action => `${action.type || 'action'}${action.destinationId ? ` → ${action.destinationId}` : ''}`).join('; ')
    return `| ${md(node.name || node.type)} | \`${md(node.id)}\` | ${md(trigger)} | ${md(details || 'No action details returned')} |`
  })
  const colorLines = (compiled.colors || []).map(color => `| ${md(color.name)} | ${md(color.rgba)} |`)
  const warningLines = (compiled.warnings || []).map(warning => `- ${md(warning)}`)
  const slotLines = records.filter(({ node, visible }) => visible && node.type === 'SLOT').map(({ node }) => {
    const ir = irByFigmaId.get(node.id)
    const owner = irOwnerByFigmaId.get(node.id)
    const target = ir && owner ? `\`${md(owner)}.${md(ir.outlet)}\`` : 'Generated in parent view'
    return `| ${md(node.name || node.type)} | \`${md(node.id)}\` | ${target} | TODO: bind app data; keep Figma sample views and layout |`
  })
  const assetCount = Object.keys(figmaData.nodeImageExports || {}).length
  const sourceNode = source.nodeId || root.id || 'Not provided'
  const rootBox = root.absoluteBoundingBox || {}

  const manifest = `# Figma UI Manifest — ${md(root.name || compiled.rootClass)}

## Source and output

- Figma node: ${figmaLink ? `[${md(sourceNode)}](${figmaLink})` : `\`${md(sourceNode)}\``}
- Root type: \`${md(root.type || 'Unknown')}\`
- Figma frame: ${Number(rootBox.width || root.size?.x || 0)} × ${Number(rootBox.height || root.size?.y || 0)} pt
- Generated UIKit root: \`${md(compiled.rootClass)}\`
- iOS deployment target: ${compiled.deploymentTarget}+
- Architecture: ${md(compiled.architecture || 'MVVM-R')}
- Visible nodes compiled: ${visibleCount}; hidden subtree roots omitted: ${hiddenRoots.length}
- Image fill nodes: ${imageFills}; Figma node image exports resolved: ${assetCount}

## Section to UIKit mapping

| Figma section | Node ID | Visibility | Visible nodes | UIKit mapping | Dynamic behavior evidence |
| --- | --- | --- | ---: | --- | --- |
${sectionLines.join('\n') || '| (No child sections) | — | — | 0 | Root view | — |'}

Repeated Figma instances are emitted as reusable views when possible. The generated screen keeps the sample views and layout as drawn. A static Figma sample does not define a runtime collection data source, API model, pagination, or empty/error states; connect those in the consuming app.

## Regions to configure

Figma SLOT nodes are explicit configuration regions. UIKitForge keeps their sample views fixed in the generated layout and marks each region with a TODO in Swift and in the TODO.md checklist for app data wiring.

| Figma region | Node ID | Generated view | Configuration TODO |
| --- | --- | --- | --- |
${slotLines.join('\n') || '| (No visible slots) | — | — | — |'}

## Reusable components

| Figma component | Source node | Component ID | Generated UIKit class | Exposed properties | Generated files |
| --- | --- | --- | --- | --- | --- |
${componentLines.join('\n') || '| (None) | — | — | — | — | — |'}

## Variants

| Instance | Node ID | Variant property | Value |
| --- | --- | --- | --- |
${variantLines.join('\n') || '| (No visible instance variants returned) | — | — | — |'}

## Hidden layers

Only the outermost hidden node in each hidden subtree is listed; its descendants are omitted with it.

| Layer | Node ID | Figma type |
| --- | --- | --- |
${hiddenLines.join('\n') || '| (No hidden layers) | — | — |'}

## Prototype interactions

| Source | Node ID | Trigger | Figma action |
| --- | --- | --- | --- |
${reactionLines.join('\n') || '| (No reactions returned for this selection) | — | — | — |'}

## Design values

### Colors emitted by UIKitForge

| Asset name | RGBA |
| --- | --- |
${colorLines.join('\n') || '| (No named colors) | — |'}

### Typography

${[...fonts].sort().map(font => `- ${md(font)}`).join('\n') || '- No font metadata returned.'}

### Auto Layout spacing values

${[...spacing].sort((a, b) => a - b).map(value => `- ${value} pt`).join('\n') || '- No Auto Layout spacing values returned.'}

## Compiler warnings

${warningLines.join('\n') || '- None.'}

## Verification status

- Browser compiler output: GENERATED.
- Native Xcode build and XIB validation: NOT VERIFIED by this export.
- iOS Simulator/device render and screenshot comparison: NOT VERIFIED by this export.
- Runtime data/API/navigation behavior: NOT VERIFIED; no backend or route contract is inferred from Figma pixels.
`

  const progress = `# Figma Implementation Progress — ${md(root.name || compiled.rootClass)}

This is a generation checkpoint. It records compiler output; it does not mark a section production-ready.

## Checkpoint

- Figma selection read: DONE (node tree received by UIKitForge).
- UIKit source generation: DONE (structural output only).
- Configuration TODOs: GENERATED at visible Figma slots; sample views and layout remain fixed to the design.
- Reusable components and visible/hidden layers: RECORDED in \`FIGMA_UI_MANIFEST.md\`.
- Asset references: RESOLVED where returned by Figma; binary assets are packaged during ZIP export.
- Runtime data model, API, navigation, and interaction wiring: NOT IMPLEMENTED from this design alone.
- Native build / XIB validation: NOT VERIFIED.
- Simulator/device rendering: NOT VERIFIED.
- Screenshot comparison and pixel-fit: NOT VERIFIED.

## Section status

| Section | Node ID | Code generated | Native/UI verification |
| --- | --- | --- | --- |
${sections.map(section => `| ${md(section.name)} | \`${md(section.id)}\` | ${section.visible ? 'Yes' : 'Omitted (hidden)'} | NOT VERIFIED |`).join('\n') || '| (No child sections) | — | — | NOT VERIFIED |'}

## Remaining work

1. Resolve marked configuration TODOs by connecting app data, APIs, and navigation while preserving the generated Figma layout.
2. Build the consuming iOS target and validate XIB/outlet integrity.
3. Render on Simulator/device, compare against the Figma node, and fix measured differences.
4. Exercise empty, single-item, multi-item, loading, and error states for dynamic sections.
`

  return [
    { path: 'FIGMA_UI_MANIFEST.md', name: 'FIGMA_UI_MANIFEST.md', language: 'markdown', content: manifest, kind: 'config' },
    { path: 'FIGMA_IMPLEMENTATION_PROGRESS.md', name: 'FIGMA_IMPLEMENTATION_PROGRESS.md', language: 'markdown', content: progress, kind: 'config' }
  ]
}

function sectionRow(section, rootVisible, irByFigmaId, componentById) {
  let visibleNodes = 0
  const instances = new Map()
  const slots = []
  const visit = (node, parentVisible) => {
    const visible = parentVisible && node.visible !== false
    if (visible) {
      visibleNodes += 1
      if (node.type === 'INSTANCE' && node.componentId) instances.set(node.componentId, (instances.get(node.componentId) || 0) + 1)
      if (node.type === 'SLOT') slots.push(node.name || node.id)
    }
    for (const child of node.children || []) visit(child, visible)
  }
  visit(section, rootVisible)

  const repeated = [...instances.entries()].filter(([, count]) => count > 1).map(([id, count]) => {
    const component = componentById.get(id)
    return `${component?.className || component?.sourceName || id} × ${count}`
  })
  const ir = irByFigmaId.get(section.id)
  const visible = rootVisible && section.visible !== false
  const mapping = visible ? `${uikitType(ir)} in ${ir?.outlet ? `\`${ir.outlet}\`` : 'root view'}` : 'Omitted because this layer is hidden'
  const evidence = !visible
    ? 'Hidden in source'
    : [
        repeated.length ? `Repeated instances: ${repeated.join(', ')}; sample views stay fixed as drawn` : null,
        slots.length ? `Figma slots: ${slots.join(', ')}; configuration TODOs mark data wiring; sample layout stays fixed` : null,
        !repeated.length && !slots.length ? 'Static sample; runtime data behavior is unspecified' : null
      ].filter(Boolean).join('; ')

  return { id: section.id || '—', name: section.name || section.type || 'Untitled', visible, visibleNodes, mapping, dynamic: evidence }
}

function uikitType(ir) {
  if (!ir) return 'UIView'
  if (ir.kind === 'label') return 'UILabel'
  if (ir.kind === 'image') return 'UIImageView'
  if (ir.kind === 'component') return ir.className || 'Reusable UIView'
  return ir.stack ? 'UIView + UIStackView' : 'UIView'
}

function md(value) {
  return String(value ?? '').replace(/[|\r\n]/g, character => character === '|' ? '\\|' : ' ')
}
