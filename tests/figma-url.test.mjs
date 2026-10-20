import assert from 'node:assert/strict'
import { collectFigmaRootCandidates, fetchFigmaSelection, normalizeNodeId, parseFigmaUrl, requiresFigmaRootSelection } from '../src/figma.js'

const links = [
  {
    url: 'https://www.figma.com/design/DesignKey/Home?node-id=22-8',
    fileKey: 'DesignKey',
    nodeId: '22:8'
  },
  {
    url: 'https://figma.com/file/LegacyKey/Home?node-id=3%3A4',
    fileKey: 'LegacyKey',
    nodeId: '3:4'
  },
  {
    url: 'https://www.figma.com/proto/PrototypeKey/Prototype?node-id=10-12&scaling=scale-down',
    fileKey: 'PrototypeKey',
    nodeId: '10:12'
  },
  {
    url: 'https://www.figma.com/design/ParentKey/branch/BranchKey/Home?node-id=22-8',
    fileKey: 'BranchKey',
    nodeId: '22:8'
  },
  {
    url: 'https://www.figma.com/design/ComponentFile/Library?node-id=300-20',
    fileKey: 'ComponentFile',
    nodeId: '300:20'
  },
  {
    url: 'https://www.figma.com/community/file/CommunityKey/Starter-File',
    fileKey: 'CommunityKey',
    nodeId: null
  },
  {
    url: 'https://www.figma.com/design/PageFile/Home',
    fileKey: 'PageFile',
    nodeId: null
  }
]

for (const { url, fileKey, nodeId } of links) {
  const parsed = parseFigmaUrl(url)
  assert.equal(parsed.fileKey, fileKey, url)
  assert.equal(parsed.nodeId, nodeId, url)
}

assert.equal(normalizeNodeId('3%3A4'), '3:4')
assert.throws(() => parseFigmaUrl(''), /Please paste a Figma URL/)
assert.throws(() => parseFigmaUrl('not a URL'), /Invalid Figma URL/)
assert.throws(() => parseFigmaUrl('http://www.figma.com/design/FileKey/Home'), /must use HTTPS/)
assert.throws(() => parseFigmaUrl('https://figma.com.example.org/design/FileKey/Home'), /not a figma\.com URL/)
assert.throws(() => parseFigmaUrl('https://www.figma.com/board/BoardKey/Board'), /Only Figma Design and Prototype links are supported/)
assert.throws(() => parseFigmaUrl('https://www.figma.com/slides/SlidesKey/Deck'), /Only Figma Design and Prototype links are supported/)
assert.throws(() => parseFigmaUrl('https://www.figma.com/make/MakeKey/Prototype'), /Only Figma Design and Prototype links are supported/)
assert.throws(() => parseFigmaUrl('https://www.figma.com/community/board/BoardKey/Board'), /does not point to a file/)
assert.throws(() => parseFigmaUrl('https://www.figma.com/design/ParentKey/branch'), /Could not find a Figma file key/)
assert.throws(
  () => parseFigmaUrl('https://www.figma.com/design/FileKey/Home?node-id=%25'),
  /Invalid Figma node ID/
)

const originalFetch = globalThis.fetch
const requests = []
try {
  globalThis.fetch = async (input, options) => {
    const url = new URL(input)
    requests.push({ url, options })
    const document = { id: url.pathname.endsWith('/nodes') ? '22:8' : '0:0', type: 'FRAME', name: 'Home', children: [] }
    return {
      ok: true,
      status: 200,
      json: async () => url.pathname.endsWith('/nodes')
        ? { nodes: { '22:8': { document } }, components: {}, componentSets: {}, styles: {} }
        : { document: { ...document, type: 'DOCUMENT' }, components: {}, componentSets: {}, styles: {} }
    }
  }

  const branch = await fetchFigmaSelection({ figmaUrl: links.find(link => link.fileKey === 'BranchKey').url, token: ' test-token ' })
  assert.equal(branch.source.fileKey, 'BranchKey')
  assert.equal(branch.root.id, '22:8')
  assert.equal(requests[0].url.pathname, '/v1/files/BranchKey/nodes')
  assert.equal(requests[0].url.searchParams.get('ids'), '22:8')
  assert.equal(requests[0].options.headers['X-Figma-Token'], 'test-token')

  const page = await fetchFigmaSelection({ figmaUrl: 'https://www.figma.com/design/PageFile/Home', token: 'test-token' })
  assert.equal(page.indexOnly, true)
  assert.equal(requests[1].url.pathname, '/v1/files/PageFile')
  assert.equal(requests[1].url.searchParams.get('depth'), '3')

  const community = await fetchFigmaSelection({ figmaUrl: 'https://www.figma.com/community/file/CommunityKey/Starter', token: 'test-token' })
  assert.equal(community.source.fileKey, 'CommunityKey')
  assert.equal(requests[2].url.pathname, '/v1/files/CommunityKey')
} finally {
  globalThis.fetch = originalFetch
}

const pageTree = {
  id: '0:0', type: 'DOCUMENT', children: [{
    id: '0:1', type: 'CANVAS', name: 'Home', children: [
      { id: '10:1', type: 'FRAME', name: 'Screen', children: [] },
      { id: '20:1', type: 'COMPONENT_SET', name: 'Button', children: [
        { id: '20:2', type: 'COMPONENT', name: 'State=On' },
        { id: '20:3', type: 'COMPONENT', name: 'State=Off', visible: false }
      ] },
      { id: '30:1', type: 'FRAME', name: 'Hidden screen', visible: false }
    ]
  }]
}
const candidates = collectFigmaRootCandidates(pageTree)
assert.deepEqual(candidates.map(({ nodeId }) => nodeId), ['10:1', '20:2'])
assert.equal(candidates[0].label, 'Home › Screen')
assert.equal(candidates[1].label, 'Home › Button › State=On')
assert.deepEqual(collectFigmaRootCandidates(pageTree.children[0].children[1]).map(({ nodeId }) => nodeId), ['20:2'])
assert.equal(requiresFigmaRootSelection({ nodeId: null }, { root: { type: 'DOCUMENT' } }), true)
assert.equal(requiresFigmaRootSelection({ nodeId: '20:1' }, { root: { type: 'COMPONENT_SET' } }), true)
assert.equal(requiresFigmaRootSelection({ nodeId: '10:1' }, { root: { type: 'FRAME' } }), false)

console.log('✓ Figma design/prototype URLs, target IDs and invalid links passed')
