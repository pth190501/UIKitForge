import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { addAndroidImageAssets, androidResourceName, generateAndroidComposeFiles } from '../src/android-compose.js'
import { componentPropertiesScreen, fidelityScreen, layoutScreen, longScreen } from './fixtures.mjs'

assert.equal(androidResourceName('Icon Bé #2'), 'icon_be_2')
assert.equal(androidResourceName('30% / Action'), 'asset_30_action')
assert.throws(() => compileUIKit(layoutScreen, 'ScreenView', { androidNamespace: 'com.example.when' }), /Android namespace/)

const layout = compileUIKit(layoutScreen, 'ScreenView').androidFiles
const screen = layout.find(file => file.kind === 'main')
assert.ok(screen)
assert.equal(screen.target, 'android-compose')
assert.equal(screen.language, 'kotlin')
assert.equal(screen.path, 'Android/src/main/java/com/example/app/uikitforge/generated/ScreenView.kt')
assert.match(screen.content, /@Composable\s+fun ScreenView/)
assert.match(screen.content, /Box\(modifier = modifier\.fillMaxWidth\(\)/)
assert.match(screen.content, /Row\(/)
assert.match(screen.content, /Column\(/)
assert.match(screen.content, /Box\(/)
assert.match(screen.content, /Modifier\.offset\(/)
assert.match(screen.content, /BasicText\(/)
const appNamespace = compileUIKit(layoutScreen, 'ScreenView', { androidNamespace: 'vnpt.myapp' }).androidFiles.find(file => file.kind === 'main')
assert.equal(appNamespace.path, 'Android/src/main/java/vnpt/myapp/uikitforge/generated/ScreenView.kt')
assert.match(appNamespace.content, /package vnpt\.myapp\.uikitforge\.generated/)
assert.match(appNamespace.content, /import vnpt\.myapp\.R/)

const long = compileUIKit(longScreen, 'LongView').androidFiles.find(file => file.kind === 'main')
assert.match(long.content, /verticalScroll\(rememberScrollState\(\)\)/)

const fidelity = compileUIKit(fidelityScreen, 'PromoView').androidFiles
assert.match(fidelity.find(file => file.kind === 'main').content, /R\.drawable\.star_icon/)
assert.match(fidelity.find(file => file.kind === 'main').content, /Brush\.linearGradient/)
assert.match(fidelity.find(file => file.kind === 'main').content, /buildAnnotatedString/)

const components = compileUIKit(componentPropertiesScreen, 'OffersView').androidFiles
const tag = components.find(file => file.name === 'TagView.kt')
assert.ok(tag)
assert.match(tag.content, /fun TagView\(/)
assert.match(tag.content, /label: String = "Hot"/)
assert.match(tag.content, /showIcon: Boolean = true/)
assert.match(components.find(file => file.kind === 'main').content, /TagView\(/)

const hostile = structuredClone(layoutScreen)
hostile.root.children[0].children[1].characters = 'Price $5 "today"'
const escaped = compileUIKit(hostile, 'ScreenView').androidFiles
assert.ok(escaped.find(file => file.kind === 'main').content.includes('Price \\$5 \\"today\\"'))

const keywordFiles = generateAndroidComposeFiles({
  rootClass: 'ScreenView',
  mainIR: { kind: 'view', outlet: 'root', frame: { width: 100, height: 100 }, sizing: { h: 'FIXED', v: 'FIXED' }, style: {}, meta: {}, children: [
    { kind: 'component', className: 'PillView', outlet: 'pill', frame: { x: 0, y: 0, width: 100, height: 30 }, sizing: { h: 'FIXED', v: 'FIXED' }, style: {}, overrides: [{ slot: { kind: 'text', param: 'when' }, value: '$5' }] }
  ] },
  componentIRs: [{ className: 'PillView', ir: {
    kind: 'view', outlet: 'pill', frame: { width: 100, height: 30 }, sizing: { h: 'FIXED', v: 'FIXED' }, style: {}, meta: {},
    slots: [{ kind: 'text', nodeId: 'text', param: 'when', fallback: 'Default' }],
    children: [{ id: 'text', kind: 'label', outlet: 'title', text: 'Default', frame: { width: 100, height: 20 }, sizing: { h: 'FIXED', v: 'HUG' }, style: {}, meta: {}, children: [] }]
  } }]
})
const keywordComponent = keywordFiles.find(file => file.name === 'PillView.kt')
assert.match(keywordComponent.content, /fun PillView\(whenValue: String = "Default"/)
assert.ok(keywordFiles.find(file => file.kind === 'main').content.includes('PillView(whenValue = "\\$5"'))

const originalFetch = globalThis.fetch
const packed = new Map()
const zip = { file(path, data, options) { packed.set(path, { data, options }) } }
try {
  globalThis.fetch = async url => ({
    ok: true,
    status: 200,
    blob: async () => new Blob(['image'], { type: String(url).includes('original') ? 'image/jpeg' : 'image/png' })
  })
  const warnings = await addAndroidImageAssets(zip, {
    assets: [{ name: 'Local Asset', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    refs: [
      { outlet: 'Photo', figmaId: '1:1' },
      { outlet: 'Original', imageRef: 'image-original' }
    ],
    nodeImageExports: { '1:1': { '2x': 'https://example.test/photo-2x.png', '3x': 'https://example.test/photo-3x.png' } },
    imageMap: { 'image-original': 'https://example.test/original.jpg' }
  })
  assert.deepEqual(warnings, [])
  assert.ok(packed.has('Android/src/main/res/drawable-nodpi/local_asset.png'))
  assert.ok(packed.has('Android/src/main/res/drawable-xhdpi/photo.png'))
  assert.ok(packed.has('Android/src/main/res/drawable-xxhdpi/photo.png'))
  assert.ok(packed.has('Android/src/main/res/drawable-nodpi/original.jpg'))
} finally {
  globalThis.fetch = originalFetch
}

console.log('✓ Android Compose generator and Android resource naming passed')
