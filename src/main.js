import JSZip from 'jszip'
import './styles.css'
import './image-mode.css'
import { fetchFigmaSelection, parseFigmaUrl, summarizeFigmaTree } from './figma.js'
import { compileUIKit } from './compiler.js'
import { analyzeScreenshot } from './screenshot.js'
import { applySwiftPreview, describeNode, rasterizePreviewToCanvas, renderUIKitPreview, walkPreview } from './preview.js'
import { diffImageData, diffSeverity } from './pixel-diff.js'

const STORAGE_KEY = 'uikitforge.figmaToken'
const SESSION_KEY = 'uikitforge.figmaToken.session'

const state = {
  figmaData: null,
  compiled: null,
  selectedFileIndex: -1,
  selectedNodeId: null,
  screenshotFile: null,
  referenceImage: null,
  overlayOpacity: 0,
  generating: false,
  inspectorTab: 'inspect',
  zoom: 'fit',
  lastScale: 1,
  showGrid: true,
  showOutlines: false,
  showSafeArea: false,
  focusPreview: false,
  inputMode: 'idle',
  outputTarget: 'uikit-xib'
}

const app = document.querySelector('#app')
app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-wrap">
        <div class="brand-mark"><span>UI</span><b>F</b></div>
        <div class="brand-copy">
          <div class="brand-title-row"><h1>UIKitForge</h1><span class="beta-pill">BETA</span></div>
          <p>Screenshot / Figma → production-ready UIKit · Swift + XIB</p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="button ghost" id="demoButton">Demo</button>
        <button class="button ghost" id="downloadFileButton" disabled>Download file</button>
        <button class="button primary" id="downloadAllButton" disabled>Export UIKit ZIP</button>
      </div>
    </header>

    <section class="mode-strip">
      <div class="mode-copy"><span class="eyebrow">INPUT MODE</span><strong id="inputModeLabel">Auto detect</strong><small id="inputModeHint">Drop only an image, paste only Figma, or use both.</small></div>
      <div class="mode-options">
        <span class="mode-pill" id="modeImage">IMAGE ONLY</span>
        <span class="mode-pill" id="modeHybrid">IMAGE + FIGMA</span>
        <span class="mode-pill" id="modeFigma">FIGMA ONLY</span>
      </div>
    </section>

    <section class="source-panel source-panel-v3">
      <div class="field screenshot-field drop-field" id="screenshotDrop">
        <label for="screenshotImage">Screenshot <span>optional if Figma is provided</span></label>
        <input id="screenshotImage" type="file" accept="image/*" />
        <div class="drop-copy"><strong>Drop screenshot here</strong><span id="screenshotName">PNG / JPG / WEBP</span></div>
      </div>
      <div class="field figma-url-field">
        <label for="figmaUrl">Figma node URL <span>optional if screenshot is provided</span></label>
        <input id="figmaUrl" type="url" placeholder="https://www.figma.com/design/...?...node-id=..." autocomplete="off" />
      </div>
      <div class="field token-field">
        <label for="figmaToken">Figma token <span>only for Figma modes</span></label>
        <div class="token-row">
          <input id="figmaToken" type="password" placeholder="figd_..." autocomplete="off" />
          <button class="icon-button" id="toggleToken" title="Show or hide token">◉</button>
          <button class="icon-button danger-text" id="forgetToken" title="Forget token">×</button>
        </div>
        <label class="check-row"><input id="rememberToken" type="checkbox" /> Remember on this device</label>
      </div>
      <div class="field root-class-field">
        <label for="rootClass">Root class</label>
        <input id="rootClass" type="text" value="GeneratedView" spellcheck="false" />
      </div>
      <div class="field output-target-field">
        <label for="outputTarget">Output</label>
        <select id="outputTarget">
          <option value="uikit-xib">UIKit (XIB)</option>
          <option value="uikit-code">UIKit (Code)</option>
          <option value="swiftui">SwiftUI</option>
        </select>
      </div>
      <div class="field deployment-target-field">
        <label for="deploymentTarget">iOS target</label>
        <select id="deploymentTarget">
          <option value="13">iOS 13</option>
          <option value="14">iOS 14</option>
          <option value="15">iOS 15</option>
          <option value="16">iOS 16</option>
          <option value="17">iOS 17+</option>
        </select>
      </div>
      <button class="button generate" id="generateButton"><span>Generate UIKit</span><b>⌘↵</b></button>
    </section>

    <section class="status-strip" id="statusStrip">
      <span class="status-dot idle"></span>
      <span id="statusText">Add a screenshot, a Figma node, or both.</span>
      <div class="status-progress" id="statusProgress" hidden><i></i></div>
      <div class="status-metrics" id="statusMetrics"></div>
    </section>

    <section class="workspace" id="workspace">
      <aside class="files-panel panel">
        <div class="panel-header"><div><span class="eyebrow">PROJECT</span><h2>Generated files</h2></div><span class="count-pill" id="fileCount">0</span></div>
        <div class="files-list empty-state" id="filesList">Generated Swift and XIB files will appear here.</div>
      </aside>

      <section class="editor-panel panel">
        <div class="panel-header editor-header">
          <div><span class="eyebrow" id="editorLanguage">EDITOR</span><h2 id="editorFilename">No file selected</h2></div>
          <span class="live-pill" id="livePill"><i></i> LIVE</span>
        </div>
        <textarea id="codeEditor" class="code-editor" spellcheck="false" disabled placeholder="Generate UIKit to start editing..."></textarea>
        <div class="editor-footer" id="editorFooter">Swift style changes are mirrored into Browser Preview.</div>
      </section>

      <section class="preview-panel panel" id="previewPanel">
        <div class="preview-toolbar">
          <div class="preview-title-wrap"><span class="eyebrow">CANVAS</span><div class="preview-title-row"><h2 id="previewTitle">UIKit layout</h2><span id="previewSize" class="preview-size">—</span></div></div>
          <div class="preview-tools">
            <div class="tool-group zoom-group"><button class="tool-button" id="zoomOutButton">−</button><button class="tool-button zoom-value" id="zoomValue">Fit</button><button class="tool-button" id="zoomInButton">+</button></div>
            <button class="tool-button active" id="gridButton">Grid</button>
            <button class="tool-button" id="outlineButton">Bounds</button>
            <button class="tool-button" id="safeAreaButton">Safe</button>
            <button class="tool-button" id="focusPreviewButton">Focus</button>
          </div>
        </div>
        <div class="reference-bar">
          <div class="reference-label"><span class="reference-dot"></span><span>Screenshot compare</span></div>
          <input id="overlayRange" type="range" min="0" max="100" value="0" />
          <span id="overlayValue">0%</span>
          <span id="diffMatchValue" class="diff-match-value" hidden></span>
        </div>
        <div class="preview-canvas grid-enabled" id="previewCanvas">
          <div class="preview-empty"><div class="phone-icon"></div><strong>Preview canvas is ready</strong><span>Image-only no longer needs a Figma URL.</span></div>
        </div>
      </section>

      <aside class="inspector-panel panel">
        <div class="panel-header inspector-header"><div><span class="eyebrow">DETAILS</span><h2>Inspector</h2></div><span class="selection-pill" id="selectionKind">—</span></div>
        <div class="inspector-tabs"><button class="inspector-tab active" data-tab="inspect">Inspect</button><button class="inspector-tab" data-tab="layers">Layers</button></div>
        <div id="inspector" class="inspector empty-state">Select a layer in Preview to inspect frame, style, layout and constraints.</div>
        <div id="layersPanel" class="layers-panel" hidden></div>
      </aside>
    </section>

    <section class="warnings-panel panel" id="warningsPanel" hidden>
      <div class="panel-header"><div><span class="eyebrow">COMPILER NOTES</span><h2>Needs attention</h2></div><span class="count-pill warning" id="warningCount">0</span></div>
      <div id="warningsList" class="warning-list"></div>
    </section>

    <footer><span>UIKitForge · browser compiler workspace</span><span>Image-only analysis runs in your browser; Figma remains optional.</span></footer>
  </main>
`

const refs = Object.fromEntries([
  'figmaUrl', 'rootClass', 'outputTarget', 'deploymentTarget', 'figmaToken', 'toggleToken', 'forgetToken', 'rememberToken', 'screenshotImage', 'screenshotDrop', 'screenshotName',
  'generateButton', 'demoButton', 'downloadFileButton', 'downloadAllButton', 'statusText', 'statusMetrics', 'statusProgress',
  'statusStrip', 'workspace', 'fileCount', 'filesList', 'editorLanguage', 'editorFilename', 'codeEditor', 'editorFooter',
  'previewPanel', 'previewCanvas', 'previewTitle', 'previewSize', 'overlayRange', 'overlayValue', 'diffMatchValue', 'inspector', 'layersPanel',
  'selectionKind', 'warningsPanel', 'warningCount', 'warningsList', 'zoomOutButton', 'zoomInButton', 'zoomValue',
  'gridButton', 'outlineButton', 'safeAreaButton', 'focusPreviewButton', 'inputModeLabel', 'inputModeHint', 'modeImage', 'modeHybrid', 'modeFigma'
].map(id => [id, document.getElementById(id)]))

restoreToken()
wireEvents()
updateInputMode()

function wireEvents() {
  refs.generateButton.addEventListener('click', generateUIKit)
  refs.outputTarget.addEventListener('change', () => { state.outputTarget = refs.outputTarget.value; if (state.compiled) { renderFileList(); selectFile(0) } })
  refs.demoButton.addEventListener('click', loadDemo)
  refs.figmaUrl.addEventListener('input', updateInputMode)
  refs.figmaToken.addEventListener('input', persistToken)
  refs.rememberToken.addEventListener('change', persistToken)

  refs.screenshotImage.addEventListener('change', event => setScreenshot(event.target.files?.[0] || null))
  for (const type of ['dragenter', 'dragover']) refs.screenshotDrop.addEventListener(type, event => { event.preventDefault(); refs.screenshotDrop.classList.add('dragging') })
  for (const type of ['dragleave', 'drop']) refs.screenshotDrop.addEventListener(type, event => { event.preventDefault(); refs.screenshotDrop.classList.remove('dragging') })
  refs.screenshotDrop.addEventListener('drop', event => {
    const file = [...(event.dataTransfer?.files || [])].find(item => item.type.startsWith('image/'))
    if (file) setScreenshot(file)
  })

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); generateUIKit() }
    if (event.key === 'Escape' && state.focusPreview) togglePreviewFocus(false)
  })

  refs.toggleToken.addEventListener('click', () => { refs.figmaToken.type = refs.figmaToken.type === 'password' ? 'text' : 'password' })
  refs.forgetToken.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(SESSION_KEY); refs.figmaToken.value = ''; refs.rememberToken.checked = false; updateInputMode(); setStatus('Figma token removed from this browser.', 'idle')
  })

  refs.overlayRange.addEventListener('input', () => { state.overlayOpacity = Number(refs.overlayRange.value) / 100; refs.overlayValue.textContent = `${refs.overlayRange.value}%`; renderPreview() })
  refs.codeEditor.addEventListener('input', () => {
    const file = currentFile(); if (!file) return
    file.content = refs.codeEditor.value
    if (file.language === 'swift') renderPreview()
    updateEditorFooter(file)
  })
  refs.downloadFileButton.addEventListener('click', downloadSelectedFile)
  refs.downloadAllButton.addEventListener('click', downloadAllFiles)
  refs.zoomValue.addEventListener('click', () => setZoom('fit'))
  refs.zoomOutButton.addEventListener('click', () => nudgeZoom(-0.1))
  refs.zoomInButton.addEventListener('click', () => nudgeZoom(0.1))
  refs.gridButton.addEventListener('click', () => toggleCanvasFlag('showGrid', refs.gridButton))
  refs.outlineButton.addEventListener('click', () => toggleCanvasFlag('showOutlines', refs.outlineButton))
  refs.safeAreaButton.addEventListener('click', () => toggleCanvasFlag('showSafeArea', refs.safeAreaButton))
  refs.focusPreviewButton.addEventListener('click', () => togglePreviewFocus())
  document.querySelectorAll('.inspector-tab').forEach(button => button.addEventListener('click', () => setInspectorTab(button.dataset.tab)))
  window.addEventListener('resize', debounce(renderPreview, 90))
  window.addEventListener('uikitforge:preview-refresh', () => renderPreview())
}

async function setScreenshot(file) {
  state.screenshotFile = file
  state.referenceImage = file ? await fileToDataUrl(file) : null
  refs.screenshotName.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'PNG / JPG / WEBP'
  refs.screenshotDrop.classList.toggle('has-file', Boolean(file))
  if (!file) setOverlay(0)
  updateInputMode()
  renderPreview()
}

function detectInputMode() {
  const hasImage = Boolean(state.screenshotFile)
  const hasFigma = Boolean(refs.figmaUrl.value.trim())
  if (hasImage && hasFigma) return 'hybrid'
  if (hasImage) return 'image'
  if (hasFigma) return 'figma'
  return 'idle'
}

function updateInputMode() {
  state.inputMode = detectInputMode()
  const info = {
    idle: ['Auto detect', 'Drop only an image, paste only Figma, or use both.'],
    image: ['Image only', 'No Figma URL or token required. Pixels → inferred UIKit hierarchy.'],
    hybrid: ['Image + Figma', 'Figma provides structure; screenshot becomes pixel-reference overlay.'],
    figma: ['Figma only', 'Uses Figma hierarchy, styles, components and image fills.']
  }[state.inputMode]
  refs.inputModeLabel.textContent = info[0]
  refs.inputModeHint.textContent = info[1]
  refs.modeImage.classList.toggle('active', state.inputMode === 'image')
  refs.modeHybrid.classList.toggle('active', state.inputMode === 'hybrid')
  refs.modeFigma.classList.toggle('active', state.inputMode === 'figma')
  refs.figmaToken.closest('.field').classList.toggle('dimmed', state.inputMode === 'image' || state.inputMode === 'idle')
}

async function generateUIKit() {
  if (state.generating) return
  updateInputMode()
  const mode = state.inputMode
  const rootClass = refs.rootClass.value.trim() || 'GeneratedView'
  if (mode === 'idle') { setStatus('Add a screenshot or paste a Figma node URL first.', 'error'); return }

  state.generating = true
  refs.generateButton.disabled = true
  refs.generateButton.querySelector('span').textContent = mode === 'image' ? 'Analyzing image…' : 'Reading Figma…'
  showProgress(0.04)

  try {
    let figmaData
    if (mode === 'image') {
      figmaData = await analyzeScreenshot(state.screenshotFile, {
        onProgress: update => { setStatus(update.message, 'loading'); showProgress(update.progress || 0) }
      })
      setStatus('Screenshot understood. Compiling inferred UIKit tree…', 'loading')
    } else {
      const figmaUrl = refs.figmaUrl.value.trim()
      const token = refs.figmaToken.value.trim()
      parseFigmaUrl(figmaUrl)
      if (!token) throw new Error('Figma mode requires a Personal Access Token. Image-only mode does not.')
      persistToken()
      setStatus('Reading Figma hierarchy, styles and image fills…', 'loading')
      showProgress(0.2)
      figmaData = await fetchFigmaSelection({ figmaUrl, token })
      showProgress(0.58)
    }

    const deploymentTarget = Number(refs.deploymentTarget.value) || 13
    const compiled = compileUIKit(figmaData, rootClass, { deploymentTarget })
    if (figmaData.analysisWarnings?.length) compiled.warnings.push(...figmaData.analysisWarnings)
    compiled.warnings = [...new Set(compiled.warnings)]
    compiled.assets = figmaData.assets || []
    compiled.imageAssetRefs = collectImageAssetRefs(compiled)
    if (figmaData.assetExportWarning) compiled.warnings.push(figmaData.assetExportWarning)
    compiled.readme = generateReadme(compiled)
    state.figmaData = figmaData
    state.compiled = compiled
    state.selectedNodeId = null
    state.zoom = 'fit'

    if (state.referenceImage) setOverlay(mode === 'image' ? 18 : mode === 'hybrid' ? 28 : 0)
    renderWorkspace()
    showProgress(1)

    if (mode === 'image') {
      const summary = summarizeFigmaTree(figmaData.root)
      setStatus(`Generated ${compiled.rootClass} from screenshot only.`, 'success', [`${summary.nodes} inferred layers`, `${figmaData.assets?.length || 0} image crops`, `${compiled.files.length} files`, `${figmaData.source?.ocrEngine || 'OCR'} OCR`])
    } else {
      const summary = summarizeFigmaTree(figmaData.root)
      setStatus(`Generated ${compiled.rootClass}${mode === 'hybrid' ? ' with screenshot reference' : ' from Figma'}.`, 'success', [`${summary.nodes} layers`, `${summary.images || 0} image fills`, `${compiled.components.length} components`, `${compiled.files.length} files`])
    }
  } catch (error) {
    console.error(error)
    setStatus(error.message || 'Generation failed.', 'error')
  } finally {
    state.generating = false
    refs.generateButton.disabled = false
    refs.generateButton.querySelector('span').textContent = 'Generate UIKit'
    setTimeout(() => hideProgress(), 350)
  }
}

function renderWorkspace() {
  if (!state.compiled) return
  renderFileList(); renderWarnings(); selectFile(0); refs.downloadAllButton.disabled = false
}

// Danh sách file hiển thị/tải theo output đang chọn — tránh trộn UIKit-XIB và UIKit-Code (cùng class name,
// build chung sẽ trùng khai báo). Config (.swiftlint.yml/.swiftformat) và README luôn kèm theo mọi output.
function visibleFiles() {
  const compiled = state.compiled
  if (!compiled) return []
  const configFiles = compiled.files.filter(file => file.kind === 'config')
  const readme = compiled.readme ? [{ path: 'README.md', name: 'README.md', language: 'markdown', content: compiled.readme, kind: 'config' }] : []
  const generated = state.outputTarget === 'swiftui'
    ? (compiled.swiftUIFiles || [])
    : compiled.files.filter(file => file.target === state.outputTarget || file.target === 'uikit')
  return [...generated, ...configFiles, ...readme]
}

function renderFileList() {
  const files = visibleFiles()
  refs.fileCount.textContent = String(files.length)
  refs.filesList.classList.remove('empty-state')
  refs.filesList.innerHTML = ''
  let previousGroup = ''
  files.forEach((file, index) => {
    const group = file.kind === 'main' ? 'Main view' : file.kind === 'component' ? 'Reusable components' : 'Project config'
    if (group !== previousGroup) { const label = document.createElement('div'); label.className = 'file-group-label'; label.textContent = group; refs.filesList.appendChild(label); previousGroup = group }
    const button = document.createElement('button')
    button.className = 'file-row'; button.dataset.index = String(index)
    button.innerHTML = `<span class="file-icon ${file.language}">${file.language === 'swift' ? 'S' : file.language === 'xml' ? 'X' : 'M'}</span><span class="file-meta"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span><span class="file-chevron">›</span>`
    button.addEventListener('click', () => selectFile(index)); refs.filesList.appendChild(button)
  })
}

function selectFile(index) {
  const file = visibleFiles()[index]; if (!file) return
  state.selectedFileIndex = index; state.selectedNodeId = null
  document.querySelectorAll('.file-row').forEach(row => row.classList.toggle('active', Number(row.dataset.index) === index))
  refs.editorFilename.textContent = file.name; refs.editorLanguage.textContent = file.language === 'swift' ? 'SWIFT' : file.language === 'xml' ? 'XIB XML' : file.language.toUpperCase(); refs.codeEditor.disabled = false; refs.codeEditor.value = file.content; refs.downloadFileButton.disabled = false
  updateEditorFooter(file)
  const root = currentPreviewRoot(); refs.previewTitle.textContent = previewDisplayName(file, root); state.selectedNodeId = root?.id || null
  renderPreview(); renderLayers(); if (root) renderInspector(root)
}

function currentFile() { return visibleFiles()[state.selectedFileIndex] || null }
function currentPreviewRoot() {
  if (!state.compiled) return null
  const file = currentFile()
  if (file?.kind === 'component') { const className = file.name.replace(/\.(swift|xib)$/i, ''); return state.compiled.componentPreviews?.[className] || state.compiled.previewRoot }
  if (state.outputTarget === 'swiftui') return state.compiled.previewRoot // cú pháp SwiftUI không khớp regex applySwiftPreview (viết cho UIKit)
  const mainSwift = state.compiled.files.find(item => item.kind === 'main' && item.language === 'swift' && item.target === state.outputTarget)
  return mainSwift ? applySwiftPreview(state.compiled.previewRoot, mainSwift.content) : state.compiled.previewRoot
}
function previewDisplayName(file, root) { return file?.kind === 'component' ? file.name.replace(/\.(swift|xib)$/i, '') : state.compiled?.rootClass || root?.name || 'UIKit layout' }

function updateEditorFooter(file) {
  if (file.language === 'swift') { refs.editorFooter.innerHTML = `<span class="footer-live-dot"></span><strong>Live:</strong> UIKit colors, text, fonts, visibility, border and corner radius update in Preview as you type.`; refs.editorFooter.classList.add('live') }
  else { refs.editorFooter.textContent = 'XIB is editable and export-ready. Image-only structure is inferred from pixels, so validate semantics before production use.'; refs.editorFooter.classList.remove('live') }
}

function renderPreview() {
  const root = currentPreviewRoot(); if (!root) return
  refs.previewSize.textContent = `${formatMetric(root.frame?.width)} × ${formatMetric(root.frame?.height)}`
  renderUIKitPreview(refs.previewCanvas, root, {
    selectedId: state.selectedNodeId, referenceImage: state.referenceImage, overlayOpacity: state.overlayOpacity, zoom: state.zoom,
    showGrid: state.showGrid, showOutlines: state.showOutlines, showSafeArea: state.showSafeArea,
    onMetrics: metrics => { state.lastScale = metrics.scale; refs.zoomValue.textContent = state.zoom === 'fit' ? `Fit ${Math.round(metrics.scale * 100)}%` : `${Math.round(metrics.scale * 100)}%`; refs.safeAreaButton.disabled = !metrics.phoneLike },
    onSelect: node => { state.selectedNodeId = node.id; renderInspector(node); renderLayers(); renderPreview() }
  })
  updatePixelDiff(root)
}

let diffRunToken = 0
// So khớp pixel định lượng giữa preview đã raster và ảnh tham chiếu (xem src/pixel-diff.js).
// Raster hoá là xấp xỉ (không dùng ibtool/Xcode thật), nên % chỉ mang tính tham khảo bố cục/màu, không phải benchmark pixel-perfect.
async function updatePixelDiff(root) {
  if (!state.referenceImage) { refs.diffMatchValue.hidden = true; return }
  const token = ++diffRunToken
  try {
    const image = await loadImageElement(state.referenceImage)
    const width = root.frame?.width || image.naturalWidth
    const height = root.frame?.height || image.naturalHeight
    if (!width || !height) return

    const previewCanvas = rasterizePreviewToCanvas(root, width, height)
    const referenceCanvas = document.createElement('canvas')
    referenceCanvas.width = previewCanvas.width
    referenceCanvas.height = previewCanvas.height
    referenceCanvas.getContext('2d').drawImage(image, 0, 0, referenceCanvas.width, referenceCanvas.height)

    const previewData = previewCanvas.getContext('2d').getImageData(0, 0, previewCanvas.width, previewCanvas.height).data
    const referenceData = referenceCanvas.getContext('2d').getImageData(0, 0, referenceCanvas.width, referenceCanvas.height).data
    const result = diffImageData(previewData, referenceData, previewCanvas.width, previewCanvas.height)

    if (token !== diffRunToken) return // một lần raster mới hơn đã chạy trong lúc await
    refs.diffMatchValue.hidden = false
    refs.diffMatchValue.textContent = `${result.matchPercent}% match`
    refs.diffMatchValue.dataset.severity = diffSeverity(result.diffPercent)
    refs.diffMatchValue.title = `${result.diffPixels} / ${result.comparedPixels} pixels differ (raster approximation, not Xcode-rendered)`
  } catch {
    refs.diffMatchValue.hidden = true
  }
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

function renderInspector(node) {
  const detail = describeNode(node); if (!detail) return
  refs.selectionKind.textContent = String(detail.kind || detail.type || 'view').toUpperCase(); refs.inspector.classList.remove('empty-state')
  const constraints = detail.constraints.length ? detail.constraints.map(item => `<li><span><b>${escapeHtml(item.type)}</b>${item.targetFigmaId ? `<small>→ ${escapeHtml(item.targetFigmaId)}</small>` : ''}</span><strong>${formatMetric(item.constant)}</strong></li>`).join('') : '<li><span><b>Root view</b><small>No parent constraints</small></span><strong>—</strong></li>'
  const style = detail.style || {}; const layout = detail.layout || {}
  const fillLabel = style.imageUrl ? 'Resolved image fill' : style.imageRef ? 'Image fill' : style.background || 'None'
  const shadowLabel = style.shadow ? `${formatMetric(style.shadow.x)}, ${formatMetric(style.shadow.y)}, blur ${formatMetric(style.shadow.blur)}` : 'None'
  refs.inspector.innerHTML = `
    <div class="inspector-hero"><div class="layer-glyph ${escapeHtml(detail.kind || 'view')}">${layerGlyph(detail)}</div><div><strong>${escapeHtml(detail.name || 'View')}</strong><span>${escapeHtml(detail.type || detail.kind || 'VIEW')}</span></div></div>
    <div class="inspector-section compact"><div class="property-row"><span>Source ID</span><code>${escapeHtml(detail.figmaId || '—')}</code></div><div class="property-row"><span>Outlet</span><code>${escapeHtml(detail.outlet || 'contentView')}</code></div>${detail.className ? `<div class="property-row"><span>Class</span><code>${escapeHtml(detail.className)}</code></div>` : ''}</div>
    <div class="inspector-section"><h3>Frame</h3><div class="metric-grid four"><span><em>X</em><b>${formatMetric(detail.frame.x)}</b></span><span><em>Y</em><b>${formatMetric(detail.frame.y)}</b></span><span><em>W</em><b>${formatMetric(detail.frame.width)}</b></span><span><em>H</em><b>${formatMetric(detail.frame.height)}</b></span></div></div>
    <div class="inspector-section"><h3>Layout</h3><div class="property-stack"><div class="property-row"><span>Direction</span><strong>${escapeHtml(layout.mode || 'NONE')}</strong></div><div class="property-row"><span>Gap</span><strong>${formatMetric(layout.itemSpacing || 0)}</strong></div><div class="property-row"><span>Padding</span><strong>${formatMetric(layout.paddingTop || 0)} · ${formatMetric(layout.paddingRight || 0)} · ${formatMetric(layout.paddingBottom || 0)} · ${formatMetric(layout.paddingLeft || 0)}</strong></div></div></div>
    <div class="inspector-section"><h3>UIKit constraints</h3><ul class="constraint-list">${constraints}</ul></div>
    <div class="inspector-section"><h3>Appearance</h3><div class="property-stack"><div class="property-row"><span>Fill</span><strong class="property-fill"><i style="background:${escapeHtml(style.background || '#111827')}"></i>${escapeHtml(shortValue(fillLabel, 32))}</strong></div><div class="property-row"><span>Radius</span><strong>${formatMetric(style.radius || 0)}</strong></div><div class="property-row"><span>Border</span><strong>${formatMetric(style.borderWidth || 0)} · ${escapeHtml(style.borderColor || 'None')}</strong></div><div class="property-row"><span>Opacity</span><strong>${Math.round((style.opacity ?? 1) * 100)}%</strong></div><div class="property-row"><span>Shadow</span><strong>${escapeHtml(shadowLabel)}</strong></div>${detail.kind === 'label' ? `<div class="property-row"><span>Typography</span><strong>${formatMetric(style.fontSize || 14)}pt · ${formatMetric(style.fontWeight || 400)} · ${escapeHtml(style.fontFamily || 'System')}</strong></div>` : ''}</div></div>`
}

function renderLayers() {
  const root = currentPreviewRoot(); if (!root) { refs.layersPanel.innerHTML = ''; return }
  refs.layersPanel.innerHTML = renderLayerNode(root, 0)
  refs.layersPanel.querySelectorAll('.layer-row').forEach(button => button.addEventListener('click', () => { const node = findPreviewNode(root, button.dataset.nodeId); if (!node) return; state.selectedNodeId = node.id; renderInspector(node); renderLayers(); renderPreview() }))
}
function renderLayerNode(node, depth) {
  const children = node.children?.length ? node.children : (node.previewChildren || []); const active = node.id === state.selectedNodeId ? ' active' : ''
  return `<button class="layer-row${active}" data-node-id="${escapeHtml(node.id)}" style="--depth:${depth}"><span class="layer-type-icon">${layerGlyph(node)}</span><span class="layer-name">${escapeHtml(node.name || node.outlet || 'View')}</span><small>${escapeHtml(node.kind || 'view')}</small></button>${children.map(child => renderLayerNode(child, depth + 1)).join('')}`
}
function findPreviewNode(root, id) { let found = null; walkPreview(root, node => { if (!found && node.id === id) found = node }); return found }
function setInspectorTab(tab) { state.inspectorTab = tab === 'layers' ? 'layers' : 'inspect'; document.querySelectorAll('.inspector-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === state.inspectorTab)); refs.inspector.hidden = state.inspectorTab !== 'inspect'; refs.layersPanel.hidden = state.inspectorTab !== 'layers'; if (state.inspectorTab === 'layers') renderLayers() }
function setZoom(value) { state.zoom = value; renderPreview() }
function nudgeZoom(delta) { const base = state.zoom === 'fit' ? state.lastScale : Number(state.zoom || 1); state.zoom = Math.max(0.2, Math.min(3, Math.round((base + delta) * 10) / 10)); renderPreview() }
function toggleCanvasFlag(key, button) { state[key] = !state[key]; button.classList.toggle('active', state[key]); renderPreview() }
function togglePreviewFocus(force) { state.focusPreview = typeof force === 'boolean' ? force : !state.focusPreview; document.body.classList.toggle('preview-focus-mode', state.focusPreview); refs.focusPreviewButton.classList.toggle('active', state.focusPreview); refs.focusPreviewButton.textContent = state.focusPreview ? 'Exit' : 'Focus'; setTimeout(renderPreview, 30) }

function renderWarnings() {
  const warnings = state.compiled?.warnings || []; refs.warningCount.textContent = String(warnings.length); refs.warningsPanel.hidden = warnings.length === 0
  refs.warningsList.innerHTML = warnings.map(text => `<div class="warning-row"><span>!</span><p>${escapeHtml(text)}</p></div>`).join('')
}

async function downloadAllFiles() {
  if (!state.compiled) return
  const zip = new JSZip()
  for (const file of visibleFiles()) zip.file(file.path, file.content)
  for (const asset of state.compiled.assets || []) addImageAsset(zip, asset)
  await addFigmaImageAssets(zip, state.compiled.imageAssetRefs || [], state.figmaData?.nodeImageExports)
  if (state.referenceImage) zip.file('References/source-screenshot.png', dataUrlPayload(state.referenceImage), { base64: true })
  zip.file('UIKitForge.generated.json', JSON.stringify({ rootClass: state.compiled.rootClass, components: state.compiled.components, warnings: state.compiled.warnings, source: state.figmaData?.source || null, assets: (state.compiled.assets || []).map(({ dataUrl, ...meta }) => meta) }, null, 2))
  const blob = await zip.generateAsync({ type: 'blob' }); downloadBlob(blob, `${state.compiled.rootClass}-UIKitForge.zip`)
}

function addImageAsset(zip, asset) {
  if (!asset?.dataUrl) return
  const name = String(asset.name || 'UIKitForgeImage').replace(/[^A-Za-z0-9_]/g, '') || 'UIKitForgeImage'
  const filename = asset.filename || `${name}.png`
  const folder = `Assets.xcassets/${name}.imageset`
  zip.file(`${folder}/${filename}`, dataUrlPayload(asset.dataUrl), { base64: true })
  zip.file(`${folder}/Contents.json`, JSON.stringify({ images: [{ idiom: 'universal', filename, scale: '1x' }, { idiom: 'universal', scale: '2x' }, { idiom: 'universal', scale: '3x' }], info: { author: 'UIKitForge', version: 1 } }, null, 2))
}

function generateReadme(compiled) {
  return `# ${compiled.rootClass}

Generated by UIKitForge · deployment target: iOS ${compiled.deploymentTarget}+

## Output layout

- \`${compiled.rootClass}/\` — main screen: XIB view + Swift outlets (UIKit-XIB), plus the MVVM-R
  \`${compiled.rootClass.replace(/View$/, '') || compiled.rootClass}ViewController/ViewModel/Router\` files,
  shared by both UIKit variants.
- \`UIKit-Code/\` — the same screen built entirely in code (NSLayoutConstraint, no XIB). Ship this
  folder instead of the XIB pair above — do not include both, they declare the same class names.
- \`SwiftUI/\` — an independent SwiftUI MVVM-R rewrite of the same layout.
- \`Components/\` / \`UIKit-Code/Components/\` / \`SwiftUI/Components/\` — reusable Figma component
  instances, one pair per component.
- \`Assets.xcassets/\` — image fills exported from Figma at @2x/@3x.
- \`.swiftlint.yml\` / \`.swiftformat\` — lint config matching the style this compiler emits.

## Figma naming conventions this compiler relies on

- **Layer name → Swift identifier.** Every layer name is sanitized into a camelCase outlet
  (\`@IBOutlet\`, \`UIImageView\`, \`Image(...)\`, SwiftUI section name). Keep layer names short,
  readable and unique within a screen — two layers with names that collide after sanitizing get a
  numeric suffix (\`title2\`), which is easy to lose track of.
- **Component instances → reusable views.** A Figma component instance compiles to its own
  \`<Name>View\` class (UIKit) / \`<Name>View\` struct (SwiftUI), reused everywhere it appears.
  Name components the way you'd name a Swift type. This also works for a nested instance inside
  another instance/screen — each distinct component becomes its own reusable class wherever it appears.
- **Image fills → image assets.** A layer with an image fill and no children compiles to a
  \`UIImageView\`/\`Image\`, and its layer name becomes the asset name in \`Assets.xcassets\`
  (\`UIImage(named: "<outlet>")\`). Keep those layer names asset-catalog-friendly.
- **Auto Layout → UIStackView / NSLayoutConstraint.** Frames with Figma Auto Layout compile to a
  \`UIStackView\` with matching axis/spacing/alignment/distribution. Frames without Auto Layout fall
  back to inferred pin constraints from each layer's Figma constraints (LEFT/RIGHT/CENTER/SCALE);
  set those explicitly in Figma for predictable results.
  Note: Figma's "wrap" Auto Layout has no UIStackView equivalent — wrapped content still compiles
  to a single line (see compiler warnings).
  Vector layers (VECTOR/BOOLEAN_OPERATION) are not exported as image assets yet — they compile to a
  plain UIView placeholder.
- **Text auto-resize → numberOfLines.** "Auto height" / "Auto width & height" text layers compile
  with \`numberOfLines = 0\`; fixed-size text layers get \`numberOfLines = 1\`.
- **Font family.** A non-default font family on a text layer is honored via
  \`UIFont(name:)\`/\`Font.custom(...)\` with a system-font fallback if that font isn't bundled in
  the target app — add the font file and an Info.plist entry yourself.
`
}

// Node có kind:'image' trong IR (main + component) — outlet của chúng là tên asset mà cả UIKit
// (UIImage(named:)) và SwiftUI (Image(...)) đều tham chiếu, nên Assets.xcassets phải đặt tên khớp.
function collectImageAssetRefs(compiled) {
  const refs = []
  const walk = node => {
    if (!node) return
    if (node.kind === 'image' && node.figmaId) refs.push({ outlet: node.outlet, figmaId: node.figmaId })
    for (const child of node.children || []) walk(child)
  }
  walk(compiled.previewRoot)
  for (const { ir } of compiled.componentIRs || []) walk(ir)
  return refs
}

// Tải PNG @2x/@3x đã export từ Figma (nodeImageExports, xem figma.js) và đóng gói vào
// Assets.xcassets/<outlet>.imageset — chỉ lúc tải zip, không tải trước lúc compile.
async function addFigmaImageAssets(zip, refs, nodeImageExports) {
  if (!nodeImageExports) return
  const seen = new Set()
  for (const { outlet, figmaId } of refs) {
    if (!outlet || seen.has(outlet)) continue
    const urls = nodeImageExports[figmaId]
    if (!urls || (!urls['2x'] && !urls['3x'])) continue
    seen.add(outlet)
    const folder = `Assets.xcassets/${outlet}.imageset`
    const images = []
    for (const scale of ['2x', '3x']) {
      const url = urls[scale]
      if (!url) continue
      try {
        const blob = await fetch(url).then(response => response.blob())
        const filename = `${outlet}@${scale}.png`
        zip.file(`${folder}/${filename}`, blob)
        images.push({ idiom: 'universal', filename, scale })
      } catch { /* bỏ qua scale này nếu URL hết hạn/mạng lỗi, các scale khác vẫn export */ }
    }
    if (images.length) zip.file(`${folder}/Contents.json`, JSON.stringify({ images, info: { author: 'UIKitForge', version: 1 } }, null, 2))
  }
}

function downloadSelectedFile() { const file = currentFile(); if (!file) return; downloadBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.name) }
function persistToken() { const value = refs.figmaToken.value.trim(); if (value) sessionStorage.setItem(SESSION_KEY, value); else sessionStorage.removeItem(SESSION_KEY); if (refs.rememberToken.checked && value) localStorage.setItem(STORAGE_KEY, value); else localStorage.removeItem(STORAGE_KEY); updateInputMode() }
function restoreToken() { const remembered = localStorage.getItem(STORAGE_KEY); const session = sessionStorage.getItem(SESSION_KEY); refs.figmaToken.value = remembered || session || ''; refs.rememberToken.checked = Boolean(remembered) }
function setStatus(message, tone = 'idle', metrics = []) { refs.statusText.textContent = message; const dot = refs.statusStrip.querySelector('.status-dot'); dot.className = `status-dot ${tone}`; refs.statusMetrics.innerHTML = metrics.map(metric => `<span>${escapeHtml(metric)}</span>`).join('') }
function showProgress(value) { refs.statusProgress.hidden = false; refs.statusProgress.querySelector('i').style.width = `${Math.max(2, Math.min(100, Number(value || 0) * 100))}%` }
function hideProgress() { refs.statusProgress.hidden = true; refs.statusProgress.querySelector('i').style.width = '0%' }
function setOverlay(percent) { refs.overlayRange.value = String(percent); refs.overlayValue.textContent = `${percent}%`; state.overlayOpacity = percent / 100 }

function loadDemo() {
  const figmaData = createDemoFigmaData(); const compiled = compileUIKit(figmaData, 'V5FastDataCardView')
  state.figmaData = figmaData; state.compiled = compiled; state.selectedNodeId = null; state.zoom = 'fit'; refs.rootClass.value = compiled.rootClass; renderWorkspace()
  setStatus('Demo loaded. Image-only mode is ready too.', 'success', [`${summarizeFigmaTree(figmaData.root).nodes} layers`, `${compiled.files.length} files`, 'Live preview'])
}
function createDemoFigmaData() {
  return { name: 'UIKitForge Demo', components: {}, componentSets: {}, styles: {}, imageMap: {}, root: { id: '1:1', type: 'FRAME', name: 'Fast Data Card', layoutMode: 'VERTICAL', itemSpacing: 12, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 20, absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 314 }, fills: [{ type: 'SOLID', color: { r: .96, g: .98, b: 1, a: 1 } }], cornerRadius: 24, children: [
    { id: '1:2', type: 'TEXT', name: 'Title', characters: 'Gói data nổi bật', absoluteBoundingBox: { x: 20, y: 20, width: 250, height: 28 }, fills: [{ type: 'SOLID', color: { r: .04, g: .07, b: .14, a: 1 } }], style: { fontSize: 22, fontWeight: 700, lineHeightPx: 28, textAutoResize: 'WIDTH_AND_HEIGHT' } },
    { id: '1:3', type: 'TEXT', name: 'Description', characters: 'Ảnh-only, Figma-only hoặc kết hợp cả hai', absoluteBoundingBox: { x: 20, y: 60, width: 330, height: 20 }, fills: [{ type: 'SOLID', color: { r: .35, g: .4, b: .5, a: 1 } }], style: { fontSize: 14, fontWeight: 400, lineHeightPx: 20, textAutoResize: 'HEIGHT' } },
    { id: '1:4', type: 'FRAME', name: 'CTA Button', absoluteBoundingBox: { x: 20, y: 228, width: 350, height: 56 }, fills: [{ type: 'SOLID', color: { r: .12, g: .36, b: .98, a: 1 } }], cornerRadius: 18, children: [{ id: '1:5', type: 'TEXT', name: 'CTA Title', characters: 'Generate UIKit', absoluteBoundingBox: { x: 138, y: 246, width: 115, height: 20 }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }], style: { fontSize: 15, fontWeight: 600, lineHeightPx: 20, textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' } }] }
  ] } }
}

function layerGlyph(node) { const kind = node.kind || node.type; if (kind === 'label' || node.type === 'TEXT') return 'T'; if (kind === 'image') return '▧'; if (kind === 'component') return '◇'; return '□' }
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) }) }
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
function dataUrlPayload(value) { return String(value || '').split(',')[1] || '' }
function formatBytes(bytes) { if (!Number.isFinite(bytes)) return ''; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB` }
function shortValue(value, max) { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') }
function formatMetric(value) { const number = Number(value); return Number.isFinite(number) ? Number(number.toFixed(2)).toString() : String(value ?? '—') }
function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay) } }
