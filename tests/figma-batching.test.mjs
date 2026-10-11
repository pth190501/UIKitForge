import assert from 'node:assert/strict'
import { batchFigmaNodeIds, fetchNodeImageExports } from '../src/figma.js'

const ids = Array.from({ length: 47 }, (_, index) => String(index))
assert.deepEqual(batchFigmaNodeIds(ids).map(group => group.length), [20, 20, 7])
assert.deepEqual(batchFigmaNodeIds(['a', 'b', 'a', 'c'], 2), [['a', 'b'], ['c']])
assert.deepEqual(batchFigmaNodeIds([], 2), [])
assert.deepEqual(batchFigmaNodeIds(['a', 'b'], 0), [['a', 'b']])

const root = {
  id: '1:1',
  type: 'FRAME',
  children: ids.map(id => ({
    id: `100:${id}`,
    type: 'RECTANGLE',
    name: `Image ${id}`,
    fills: [{ type: 'IMAGE', imageRef: `image-${id}` }]
  }))
}

const originalFetch = globalThis.fetch
let calls = []
try {
  globalThis.fetch = async url => {
    const parsed = new URL(url)
    const batch = (parsed.searchParams.get('ids') || '').split(',')
    const scale = parsed.searchParams.get('scale')
    calls.push({ batch, scale })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        images: Object.fromEntries(batch.map(id => [id, `https://example.test/${id}-${scale}.png`]))
      })
    }
  }
  const result = await fetchNodeImageExports('filekey', root, 'mock')
  assert.equal(calls.length, 6, '47 assets must be split into 3 batches, at both resolutions')
  assert.ok(calls.every(call => call.batch.length <= 20), 'requests must be bounded')
  assert.equal(Object.keys(result.nodeImageExports).length, 47)
  assert.equal(result.nodeImageExports['100:0']['2x'], 'https://example.test/100:0-2.png')
  assert.equal(result.nodeImageExports['100:46']['3x'], 'https://example.test/100:46-3.png')
  assert.equal(result.assetExportWarning, null)

  calls = []
  globalThis.fetch = async url => {
    const parsed = new URL(url)
    const batch = (parsed.searchParams.get('ids') || '').split(',')
    const scale = parsed.searchParams.get('scale')
    calls.push(scale)
    if (scale === '3') return { ok: false, status: 403, json: async () => ({ err: 'mock denied' }) }
    return { ok: true, status: 200, json: async () => ({
      images: Object.fromEntries(batch.map(id => [id, `https://example.test/${id}-2.png`]))
    }) }
  }
  const partial = await fetchNodeImageExports('filekey', root, 'mock')
  assert.equal(Object.keys(partial.nodeImageExports).length, 47)
  assert.equal(partial.nodeImageExports['100:46']['3x'], null)
  assert.match(partial.assetExportWarning, /Image export incomplete:/)
  assert.equal(calls.length, 6)
} finally {
  globalThis.fetch = originalFetch
}

console.log('✓ large Figma image batching, 2x/3x export, partial failure passed')
