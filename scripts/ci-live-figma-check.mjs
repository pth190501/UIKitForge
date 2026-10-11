// Large, real-design compilation smoke test. Requires FIGMA_TOKEN.
// This is not a pixel-perfect assertion; a native screenshot remains required.
import { mkdirSync, writeFileSync } from 'node:fs'
import { compileUIKit } from '../src/compiler.js'
import { figmaGet, summarizeFigmaTree } from '../src/figma.js'

const fileKey = 'zlEC3PlD37tAJLFbdUGCnm'
const nodeId = '28104:5174'
const token = process.env.FIGMA_TOKEN?.trim()
const output = 'large-figma-artifacts'
mkdirSync(output, { recursive: true })

const writeReport = report => {
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2))
}

if (!token) {
  writeReport({ status: 'SKIPPED', reason: 'FIGMA_TOKEN secret is unavailable', fileKey, nodeId })
  console.log('Large Figma smoke test SKIPPED: set FIGMA_TOKEN as a repository secret.')
} else {
  const started = Date.now()
  try {
    const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
    const data = await figmaGet(url, token)
    const root = data?.nodes?.[nodeId]?.document
    if (!root) throw new Error('Requested Figma node is missing from the API payload')
    const tree = summarizeFigmaTree(root)
    const compiled = compileUIKit({
      root,
      components: data.components || {},
      componentSets: data.componentSets || {},
      styles: data.styles || {},
      imageMap: {},
      source: { fileKey, nodeId }
    }, 'HomeIndividualView', { deploymentTarget: 13, architecture: 'mvvm-r' })

    const warnings = [...new Set(compiled.warnings || [])]
    const report = {
      status: 'COMPILED',
      fileKey,
      nodeId,
      elapsedMs: Date.now() - started,
      tree,
      dimensions: compiled.previewRoot?.frame || null,
      nativeCandidates: compiled.nativeRegions,
      outputFiles: compiled.files.length,
      reusableComponents: compiled.components.length,
      swiftFiles: compiled.files.filter(file => file.language === 'swift').length,
      xibFiles: compiled.files.filter(file => file.path.endsWith('.xib')).length,
      warnings,
      note: 'Compile-only. Pixel match requires real UIKit render, source asset downloads and Figma reference.'
    }
    writeReport(report)
    console.log(JSON.stringify({
      status: report.status,
      elapsedMs: report.elapsedMs,
      nodes: tree.nodes,
      files: report.outputFiles,
      nativeCandidates: report.nativeCandidates.length,
      warnings: warnings.length
    }, null, 2))
  } catch (error) {
    writeReport({ status: 'FAILED', fileKey, nodeId, elapsedMs: Date.now() - started, error: error.message })
    throw error
  }
}
