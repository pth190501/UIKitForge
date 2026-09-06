import assert from 'node:assert/strict'
import { figmaPaintToCss } from '../src/figma.js'
import { compileUIKit } from '../src/compiler.js'

const gradient = figmaPaintToCss({
  type: 'GRADIENT_LINEAR',
  gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  gradientStops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }
  ]
})
assert.match(gradient, /^linear-gradient\(/)

const data = {
  imageMap: { hero: 'https://example.com/hero.png' },
  root: {
    id: '1:1', type: 'FRAME', name: 'Rich Preview',
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 200 },
    fills: [{
      type: 'GRADIENT_LINEAR',
      gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      gradientStops: [
        { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
        { position: 1, color: { r: 0.8, g: 0.9, b: 1, a: 1 } }
      ]
    }],
    children: [{
      id: '1:2', type: 'RECTANGLE', name: 'Hero Image',
      absoluteBoundingBox: { x: 16, y: 16, width: 358, height: 120 },
      fills: [{ type: 'IMAGE', imageRef: 'hero', scaleMode: 'FILL' }]
    }]
  }
}

const compiled = compileUIKit(data, 'RichPreviewView')
assert.match(compiled.previewRoot.style.background, /^linear-gradient\(/)
assert.equal(compiled.previewRoot.children[0].kind, 'image')
assert.equal(compiled.previewRoot.children[0].style.imageUrl, 'https://example.com/hero.png')
assert.equal(compiled.previewRoot.children[0].style.imageRef, 'hero')

console.log('✓ rich preview gradients and image fills passed')
