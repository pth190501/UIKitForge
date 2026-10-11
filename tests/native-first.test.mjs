import assert from 'node:assert/strict'
import { discoverNativeRegions, nativePlanMarkdown, nativeSupportFiles } from '../src/native-first.js'
import { compileUIKit } from '../src/compiler.js'
import { fidelityScreen } from './fixtures.mjs'

const tree = {
  id: '1:1', type: 'FRAME', name: 'Home',
  absoluteBoundingBox: { width: 375, height: 3999 },
  children: [
    { id: '1:2', type: 'FRAME', name: 'Banner', children: [] },
    { id: '1:3', type: 'FRAME', name: 'Feed content',
      children: [{ id: '1:4', type: 'RECTANGLE' }, { id: '1:5', type: 'RECTANGLE' }] },
    { id: '1:6', type: 'FRAME', name: 'Menu bar' },
    { id: '1:7', type: 'FRAME', name: 'Hidden slider', visible: false },
    { id: '1:8', type: 'TEXT', name: 'Banner' }
  ]
}

const regions = discoverNativeRegions(tree)
assert.deepEqual(regions.map(region => region.nodeId), ['1:2', '1:3', '1:6'])
assert.equal(regions[0].suggestion, 'UICollectionView + UIPageControl')
assert.match(nativePlanMarkdown(tree, regions), /375 × 3999 pt/)
assert.match(nativePlanMarkdown(tree, regions), /real render/)
const support = nativeSupportFiles(regions)
assert.equal(support.length, 1)
assert.match(support[0].content, /UICollectionViewFlowLayout/)
assert.match(support[0].content, /UIPageControl/)
assert.match(support[0].content, /pageControl.numberOfPages = banners.count/)
assert.match(support[0].content, /pageControl.isHidden = banners.count <= 1/)
assert.match(support[0].content, /scrollViewDidEndDecelerating/)
assert.match(support[0].content, /guard !banners.isEmpty/)
assert.equal(nativeSupportFiles([]).length, 0)

const compiled = compileUIKit(fidelityScreen, 'PromoView', { deploymentTarget: 13 })
const generatedSupport = compiled.files.find(file => file.name === 'ForgeBannerCarouselView.swift')
assert.ok(generatedSupport, 'Banner-bearing Figma design exports a native UIKit building block')
assert.equal(generatedSupport.target, 'uikit')
assert.ok(compiled.files.some(file => file.path === 'NATIVE_UI_PLAN.md'))
assert.ok(compiled.nativeRegions.some(region => region.name === 'Banner'))

console.log('✓ native UIKit mapping and dynamic banner carousel export passed')
