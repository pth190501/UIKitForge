import assert from 'node:assert/strict'
import { auditFigmaNodeCoverage, nodeCoverageMarkdown, auditExportPaths } from '../src/node-coverage.js'
import { compileUIKit } from '../src/compiler.js'
import { fidelityScreen } from './fixtures.mjs'

const root = {
  id: '1:1', name: 'Root', type: 'FRAME',
  children: [
    { id: '1:2', name: 'Label', type: 'TEXT' },
    { id: '1:3', name: 'Hidden', type: 'FRAME', visible: false,
      children: [{ id: '1:4', name: 'Hidden child', type: 'TEXT' }] },
    { id: '1:5', name: 'Card instance', type: 'INSTANCE',
      children: [{ id: '1:6', name: 'Card child', type: 'TEXT' }] },
    { id: '1:7', name: 'Raster group', type: 'GROUP',
      children: [{ id: '1:8', name: 'Raster child', type: 'TEXT' }] },
    { id: '1:9', name: 'Unknown unsupported leaf', type: 'UNSUPPORTED' },
    { id: '1:10', name: 'Photo', type: 'RECTANGLE',
      fills: [{ type: 'IMAGE', imageRef: 'img-a' }] }
  ]
}
const ir = (id, kind = 'view', extra = {}) => ({ figmaId: id, kind, children: [], meta: {}, ...extra })
const compiled = {
  rootClass: 'RootView',
  sourceRoot: root,
  previewRoot: ir('1:1', 'view', {
    children: [ir('1:2', 'label'), ir('1:5', 'component'),
      ir('1:7', 'image', { meta: { rasterized: true } }), ir('1:10', 'image')]
  }),
  componentIRs: []
}
const report = auditFigmaNodeCoverage(compiled, {})
assert.equal(report.totalNodes, 10)
assert.equal(report.status, 'INCOMPLETE')
assert.deepEqual(report.missingNodeIds, ['1:9'])
assert.equal(report.counts['inside-component'], 1)
assert.equal(report.counts['inside-raster'], 1)
assert.equal(report.counts.hidden, 2)
assert.equal(report.assetIssues.length, 2)
assert.equal(report.nativeScreenshotVerified, false)
assert.equal(report.pixelPerfectVerified, false)
assert.match(nodeCoverageMarkdown(report), /NOT VERIFIED/)

const resolved = auditFigmaNodeCoverage(compiled, {
  imageMap: { 'img-a': 'https://assets.invalid/photo.png' },
  nodeImageExports: { '1:7': { '2x': 'https://assets.invalid/raster.png' } }
})
assert.equal(resolved.assetIssues.length, 0)
assert.deepEqual(resolved.missingNodeIds, ['1:9'])
const withoutMissing = structuredClone(compiled)
withoutMissing.sourceRoot.children = withoutMissing.sourceRoot.children.filter(node => node.id !== '1:9')
const clean = auditFigmaNodeCoverage(withoutMissing, {
  imageMap: { 'img-a': 'https://assets.invalid/photo.png' },
  nodeImageExports: { '1:7': { '3x': 'https://assets.invalid/raster.png' } }
})
assert.equal(clean.status, 'GENERATED_UNVERIFIED')
assert.equal(clean.pixelPerfectVerified, false)

assert.equal(auditExportPaths([{ path: 'Root/Root.swift', target: 'uikit-xib' },
  { path: 'Root/Root.swift', target: 'uikit-code' }]).ok, true)
assert.deepEqual(auditExportPaths([{ path: 'A.swift', target: 'uikit-xib' },
  { path: 'A.swift', target: 'uikit-xib' }]).collisions,
[{ path: 'A.swift', target: 'uikit-xib' }])
assert.equal(auditExportPaths([{ path: '../secrets.txt' }]).ok, false)
assert.equal(auditExportPaths([{ path: '/absolute.txt' }]).ok, false)

const actual = compileUIKit(fidelityScreen, 'CoverageTestView', { deploymentTarget: 13 })
assert.ok(actual.nodeCoverage)
assert.equal(actual.nodeCoverage.pixelPerfectVerified, false)
assert.ok(actual.files.some(file => file.path === 'Reports/FIGMA_NODE_COVERAGE.md'))
assert.ok(actual.files.some(file => file.path === 'Reports/FIGMA_NODE_COVERAGE.json'))
assert.equal(actual.exportPathAudit.ok, true)
console.log('✓ exhaustive Figma node coverage and safe export paths passed')
