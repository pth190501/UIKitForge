import JSZip from 'jszip'
import './styles.css'
import { fetchFigmaSelection, parseFigmaUrl, summarizeFigmaTree } from './figma.js'
import { compileUIKit } from './compiler.js'
import { applySwiftPreview, describeNode, renderUIKitPreview, walkPreview } from './preview.js'

const STORAGE_KEY = 'uikitforge.figmaToken'
const SESSION_KEY = 'uikitforge.figmaToken.session'

const state = {
  figmaData: null,
  compiled: null,
  selectedFileIndex: -1,
  selectedNodeId: null,
  referenceImage: null,
  overlayOpacity: 0,
  generating: false,
  inspectorTab: 'inspect',
  zoom: 'fit',
  lastScale: 1,
  showGrid: true,
  showOutlines: false,
  showSafeArea: false,
  focusPreview: false
}

const app = document.querySelector('#app')
app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-wrap">
        <div class="brand-mark"><span>UI</span><b>F</b></div>
        <div class="brand-copy">
          <div class="brand-title-row"><h1>UIKitForge</h1><span class="beta-pill">BETA</span></div>
          <p>Figma → production-ready UIKit · Swift + XIB</p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="button ghost" id="demoButton">Demo</button>
        <button class="button ghost" id="downloadFileButton" disabled>Download file</button>
        <button class="button primary" id="downloadAllButton" disabled>Export UIKit ZIP</button>
      </div>
    </header>

    <section class="source-panel">
      <div class="field figma-url-field">
        <label for="figmaUrl">Figma node URL</label>
        <input id="figmaUrl" type="url" placeholder="https://www.figma.com/design/...?...node-id=..." autocomplete="off" />
      </div>
      <div class="field root-class-field">
        <label for="rootClass">Root class</label>
        <input id="rootClass" type="text" value="GeneratedView" spellcheck="false" />
      </div>
      <div class="field token-field">
        <label for="figmaToken">Personal access token</label>
        <div class="token-row">
          <input id="figmaToken" type="password" placeholder="figd_..." autocomplete="off" />
          <button class="icon-button" id="toggleToken" title="Show or hide token">◉</button>
          <button class="icon-button danger-text" id="forgetToken" title="Forget token">×</button>
        </div>
        <label class="check-row"><input id="rememberToken" type="checkbox" /> Remember on this device</label>
      </div>
      <div class="field reference-field">
        <label for="referenceImage">Reference screenshot <span>optional</span></label>
        <input id="referenceImage" type="file" accept="image/*" />
      </div>
      <button class="button generate" id="generateButton"><span>Generate UIKit</span><b>⌘↵</b></button>
    </section>

    <section class="status-strip" id="statusStrip">
      <span class="status-dot idle"></span>
      <span id="statusText">Paste a Figma node URL and token, or load the built-in demo.</span>
      <div class="status-metrics" id="statusMetrics"></div>
    </section>

    <section class="workspace" id="workspace">
      <aside class="files-panel panel">
        <div class="panel-header">
          <div><span class="eyebrow">PROJECT</span><h2>Generated files</h2></div>
          <span class="count-pill" id="fileCount">0</span>
        </div>
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
          <div class="preview-title-wrap">
            <span class="eyebrow">CANVAS</span>
            <div class="preview-title-row"><h2 id="previewTitle">UIKit layout</h2><span id="previewSize" class="preview-size">—</span></div>
          </div>
          <div class="preview-tools">
            <div class="tool-group zoom-group">
              <button class="tool-button" id="zoomOutButton" title="Zoom out">−</button>
              <button class="tool-button zoom-value" id="zoomValue" title="Fit canvas">Fit</button>
              <button class="tool-button" id="zoomInButton" title="Zoom in">+</button>
            </div>
            <button class="tool-button active" id="gridButton" title="Toggle grid">Grid</button>
            <button class="tool-button" id="outlineButton" title="Show all layer bounds">Bounds</button>
            <button class="tool-button" id="safeAreaButton" title="Show iOS safe area">Safe</button>
            <button class="tool-button" id="focusPreviewButton" title="Focus preview">Focus</button>
          </div>
        </div>
        <div class="reference-bar">
          <div class="reference-label"><span class="reference-dot"></span><span>Reference overlay</span></div>
          <input id="overlayRange" type="range" min="0" max="100" value="0" />
          <span id="overlayValue">0%</span>
        </div>
        <div class="preview-canvas grid-enabled" id="previewCanvas">
          <div class="preview-empty">
            <div class="phone-icon"></div>
            <strong>Preview canvas is ready</strong>
            <span>Generate from Figma or load the demo.</span>
          </div>
        </div>
      </section>

      <aside class="inspector-panel panel">
        <div class="panel-header inspector-header">
          <div><span class="eyebrow">DETAILS</span><h2>Inspector</h2></div>
          <span class="selection-pill" id="selectionKind">—</span>
        </div>
        <div class="inspector-tabs">
          <button class="inspector-tab active" data-tab="inspect">Inspect</button>
          <button class="inspector-tab" data-tab="layers">Layers</button>
        </div>
        <div id="inspector" class="inspector empty-state">Select a layer in Preview to inspect frame, style, layout and constraints.</div>
        <div id="layersPanel" class="layers-panel" hidden></div>
      </aside>
    </section>

    <section class="warnings-panel panel" id="warningsPanel" hidden>
      <div class="panel-header">
        <div><span class="eyebrow">COMPILER NOTES</span><h2>Needs attention</h2></div>
        <span class="count-pill warning" id="warningCount">0</span>
      </div>
      <div id="warningsList" class="warning-list"></div>
    </section>

    <footer>
      <span>UIKitForge · browser compiler workspace</span>
      <span>Preview now resolves Figma image fills, gradients, components and live Swift styling.</span>
    </footer>
  </main>
`

const refs = Object.fromEntries([
  'figmaUrl', 'rootClass', 'figmaToken', 'toggleToken', 'forgetToken', 'rememberToken', 'referenceImage',
  'generateButton', 'demoButton', 'downloadFileButton', 'downloadAllButton', 'statusText', 'statusMetrics',
  'statusStrip', 'workspace', 'fileCount', 'filesList', 'editorLanguage', 'editorFilename', 'codeEditor', 'editorFooter',
  'previewPanel', 'previewCanvas', 'previewTitle', 'previewSize', 'overlayRange', 'overlayValue', 'inspector', 'layersPanel',
  'selectionKind', 'warningsPanel', 'warningCount', 'warningsList', 'zoomOutButton', 'zoomInButton', 'zoomValue',
  'gridButton', 'outlineButton', 'safeAreaButton', 'focusPreviewButton'
].map(id => [id, document.getElementById(id)]))

restoreToken()
wireEvents()

function wireEvents() {
  refs.generateButton.addEventListener('click', generateFromFigma)
  refs.demoButton.addEventListener('click', loadDemo)

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      generateFromFigma()
    }
    if (event.key === 'Escape' && state.focusPreview) togglePreviewFocus(false)
  })

  refs.toggleToken.addEventListener('click', () => {
    refs.figmaToken.type = refs.figmaToken.type === 'password' ? 'text' : 'password'
  })

  refs.forgetToken.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(SESSION_KEY)
    refs.figmaToken.value = ''
    refs.rememberToken.checked = false
    setStatus('Figma token removed from this browser.', 'idle')
  })

  refs.figmaToken.addEventListener('input', persistToken)
  refs.rememberToken.addEventListener('change', persistToken)

  refs.referenceImage.addEventListener('change', async event => {
    const file = event.target.files?.[0]
    state.referenceImage = file ? await fileToDataUrl(file) : null
    if (!state.referenceImage) {
      state.overlayOpacity = 0
      refs.overlayRange.value = '0'
      refs.overlayValue.textContent = '0%'
    }
    renderPreview()
  })

  refs.overlayRange.addEventListener('input', () => {
    state.overlayOpacity = Number(refs.overlayRange.value) / 100
    refs.overlayValue.textContent = `${refs.overlayRange.value}%`
    renderPreview()
  })

  refs.codeEditor.addEventListener('input', () => {
    const file = currentFile()
    if (!file) return
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

  document.querySelectorAll('.inspector-tab').forEach(button => {
    button.addEventListener('click', () => setInspectorTab(button.dataset.tab))
  })

  window.addEventListener('resize', debounce(renderPreview, 90))
  window.addEventListener('uikitforge:preview-refresh', () => renderPreview())
}

async function generateFromFigma() {
  if (state.generating) return
  const figmaUrl = refs.figmaUrl.value.trim()
  const token = refs.figmaToken.value.trim()
  const rootClass = refs.rootClass.value.trim()

  try {
    parseFigmaUrl(figmaUrl)
  } catch (error) {
    setStatus(error.message, 'error')
    refs.figmaUrl.focus()
    return
  }

  if (!token) {
    setStatus('Enter a Figma Personal Access Token with file_content:read permission.', 'error')
    refs.figmaToken.focus()
    return
  }

  state.generating = true
  refs.generateButton.disabled = true
  refs.generateButton.querySelector('span').textContent = 'Reading Figma…'
  setStatus('Reading Figma hierarchy, styles and image fills…', 'loading')
  persistToken()

  try {
    const figmaData = await fetchFigmaSelection({ figmaUrl, token })
    setStatus('Figma loaded. Compiling UIKit hierarchy and preview…', 'loading')
    const compiled = compileUIKit(figmaData, rootClass)
    state.figmaData = figmaData
    state.compiled = compiled
    state.selectedNodeId = null
    state.zoom = 'fit'
    renderWorkspace()

    const summary = summarizeFigmaTree(figmaData.root)
    setStatus(`Generated ${compiled.rootClass} from Figma.`, 'success', [
      `${summary.nodes} layers`,
      `${summary.images} image fills`,
      `${compiled.components.length} components`,
      `${compiled.files.length} files`
    ])
  } catch (error) {
    console.error(error)
    setStatus(error.message || 'Generation failed.', 'error')
  } finally {
    state.generating = false
    refs.generateButton.disabled = false
    refs.generateButton.querySelector('span').textContent = 'Generate UIKit'
  }
}

function loadDemo() {
  const figmaData = createDemoFigmaData()
  const compiled = compileUIKit(figmaData, 'V5FastDataCardView')
  state.figmaData = figmaData
  state.compiled = compiled
  state.selectedNodeId = null
  state.zoom = 'fit'
  refs.rootClass.value = compiled.rootClass
  renderWorkspace()
  setStatus('Demo loaded. Select layers, switch component files, toggle bounds, or edit Swift live.', 'success', [
    `${summarizeFigmaTree(figmaData.root).nodes} layers`,
    `${compiled.components.length} component`,
    `${compiled.files.length} files`,
    'Live preview'
  ])
}

function renderWorkspace() {
  if (!state.compiled) return
  renderFileList()
  renderWarnings()
  selectFile(0)
  refs.downloadAllButton.disabled = false
}

function renderFileList() {
  const files = state.compiled.files
  refs.fileCount.textContent = String(files.length)
  refs.filesList.classList.remove('empty-state')
  refs.filesList.innerHTML = ''

  let previousGroup = ''
  files.forEach((file, index) => {
    const group = file.kind === 'main' ? 'Main view' : 'Reusable components'
    if (group !== previousGroup) {
      const label = document.createElement('div')
      label.className = 'file-group-label'
      label.textContent = group
      refs.filesList.appendChild(label)
      previousGroup = group
    }

    const button = document.createElement('button')
    button.className = 'file-row'
    button.dataset.index = String(index)
    button.innerHTML = `
      <span class="file-icon ${file.language}">${file.language === 'swift' ? 'S' : 'X'}</span>
      <span class="file-meta"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span>
      <span class="file-chevron">›</span>`
    button.addEventListener('click', () => selectFile(index))
    refs.filesList.appendChild(button)
  })
}

function selectFile(index) {
  const file = state.compiled?.files?.[index]
  if (!file) return

  state.selectedFileIndex = index
  state.selectedNodeId = null
  document.querySelectorAll('.file-row').forEach(row => row.classList.toggle('active', Number(row.dataset.index) === index))
  refs.editorFilename.textContent = file.name
  refs.editorLanguage.textContent = file.language === 'swift' ? 'SWIFT' : 'XIB XML'
  refs.codeEditor.disabled = false
  refs.codeEditor.value = file.content
  refs.downloadFileButton.disabled = false
  updateEditorFooter(file)

  const root = currentPreviewRoot()
  refs.previewTitle.textContent = previewDisplayName(file, root)
  state.selectedNodeId = root?.id || null
  renderPreview()
  renderLayers()
  if (root) renderInspector(root)
}

function currentFile() {
  return state.compiled?.files?.[state.selectedFileIndex] || null
}

function currentPreviewRoot() {
  if (!state.compiled) return null
  const file = currentFile()

  if (file?.kind === 'component') {
    const className = file.name.replace(/\.(swift|xib)$/i, '')
    return state.compiled.componentPreviews?.[className] || state.compiled.previewRoot
  }

  const mainSwift = state.compiled.files.find(item => item.kind === 'main' && item.language === 'swift')
  return mainSwift ? applySwiftPreview(state.compiled.previewRoot, mainSwift.content) : state.compiled.previewRoot
}

function previewDisplayName(file, root) {
  if (file?.kind === 'component') return file.name.replace(/\.(swift|xib)$/i, '')
  return state.compiled?.rootClass || root?.name || 'UIKit layout'
}

function updateEditorFooter(file) {
  if (file.language === 'swift') {
    refs.editorFooter.innerHTML = `<span class="footer-live-dot"></span><strong>Live:</strong> UIKit colors, text, fonts, visibility, border and corner radius update in Preview as you type.`
    refs.editorFooter.classList.add('live')
  } else {
    refs.editorFooter.textContent = 'XIB is editable and export-ready. Preview follows compiler IR and generated Swift; native Interface Builder rendering remains a separate validation step.'
    refs.editorFooter.classList.remove('live')
  }
}

function renderPreview() {
  const root = currentPreviewRoot()
  if (!root) return

  refs.previewSize.textContent = `${formatMetric(root.frame?.width)} × ${formatMetric(root.frame?.height)}`
  renderUIKitPreview(refs.previewCanvas, root, {
    selectedId: state.selectedNodeId,
    referenceImage: state.referenceImage,
    overlayOpacity: state.overlayOpacity,
    zoom: state.zoom,
    showGrid: state.showGrid,
    showOutlines: state.showOutlines,
    showSafeArea: state.showSafeArea,
    onMetrics: metrics => {
      state.lastScale = metrics.scale
      refs.zoomValue.textContent = state.zoom === 'fit' ? `Fit ${Math.round(metrics.scale * 100)}%` : `${Math.round(metrics.scale * 100)}%`
      refs.safeAreaButton.disabled = !metrics.phoneLike
    },
    onSelect: node => {
      state.selectedNodeId = node.id
      renderInspector(node)
      renderLayers()
      renderPreview()
    }
  })
}

function renderInspector(node) {
  const detail = describeNode(node)
  if (!detail) return

  refs.selectionKind.textContent = String(detail.kind || detail.type || 'view').toUpperCase()
  refs.inspector.classList.remove('empty-state')

  const constraints = detail.constraints.length
    ? detail.constraints.map(item => {
        const target = item.targetFigmaId ? `<small>→ ${escapeHtml(item.targetFigmaId)}</small>` : ''
        return `<li><span><b>${escapeHtml(item.type)}</b>${target}</span><strong>${formatMetric(item.constant)}</strong></li>`
      }).join('')
    : '<li><span><b>Root view</b><small>No parent constraints</small></span><strong>—</strong></li>'

  const style = detail.style || {}
  const layout = detail.layout || {}
  const fillLabel = style.imageUrl
    ? 'Resolved image fill'
    : style.imageRef
      ? 'Image fill'
      : style.background || 'None'

  const shadowLabel = style.shadow
    ? `${formatMetric(style.shadow.x)}, ${formatMetric(style.shadow.y)}, blur ${formatMetric(style.shadow.blur)}`
    : 'None'

  refs.inspector.innerHTML = `
    <div class="inspector-hero">
      <div class="layer-glyph ${escapeHtml(detail.kind || 'view')}">${layerGlyph(detail)}</div>
      <div><strong>${escapeHtml(detail.name || 'View')}</strong><span>${escapeHtml(detail.type || detail.kind || 'VIEW')}</span></div>
    </div>

    <div class="inspector-section compact">
      <div class="property-row"><span>Figma ID</span><code>${escapeHtml(detail.figmaId || '—')}</code></div>
      <div class="property-row"><span>Outlet</span><code>${escapeHtml(detail.outlet || 'contentView')}</code></div>
      ${detail.className ? `<div class="property-row"><span>Class</span><code>${escapeHtml(detail.className)}</code></div>` : ''}
    </div>

    <div class="inspector-section">
      <h3>Frame</h3>
      <div class="metric-grid four">
        <span><em>X</em><b>${formatMetric(detail.frame.x)}</b></span>
        <span><em>Y</em><b>${formatMetric(detail.frame.y)}</b></span>
        <span><em>W</em><b>${formatMetric(detail.frame.width)}</b></span>
        <span><em>H</em><b>${formatMetric(detail.frame.height)}</b></span>
      </div>
    </div>

    <div class="inspector-section">
      <h3>Figma Auto Layout</h3>
      <div class="property-stack">
        <div class="property-row"><span>Direction</span><strong>${escapeHtml(layout.mode || 'NONE')}</strong></div>
        <div class="property-row"><span>Gap</span><strong>${formatMetric(layout.itemSpacing || 0)}</strong></div>
        <div class="property-row"><span>Padding</span><strong>${formatMetric(layout.paddingTop || 0)} · ${formatMetric(layout.paddingRight || 0)} · ${formatMetric(layout.paddingBottom || 0)} · ${formatMetric(layout.paddingLeft || 0)}</strong></div>
        <div class="property-row"><span>Sizing</span><strong>${escapeHtml(layout.layoutSizingHorizontal || '—')} / ${escapeHtml(layout.layoutSizingVertical || '—')}</strong></div>
      </div>
    </div>

    <div class="inspector-section">
      <h3>UIKit constraints</h3>
      <ul class="constraint-list">${constraints}</ul>
    </div>

    <div class="inspector-section">
      <h3>Appearance</h3>
      <div class="property-stack">
        <div class="property-row"><span>Fill</span><strong class="property-fill"><i style="background:${escapeHtml(style.background || '#111827')}"></i>${escapeHtml(shortValue(fillLabel, 32))}</strong></div>
        <div class="property-row"><span>Radius</span><strong>${formatMetric(style.radius || 0)}</strong></div>
        <div class="property-row"><span>Border</span><strong>${formatMetric(style.borderWidth || 0)} · ${escapeHtml(style.borderColor || 'None')}</strong></div>
        <div class="property-row"><span>Opacity</span><strong>${Math.round((style.opacity ?? 1) * 100)}%</strong></div>
        <div class="property-row"><span>Shadow</span><strong>${escapeHtml(shadowLabel)}</strong></div>
        ${detail.kind === 'label' ? `<div class="property-row"><span>Typography</span><strong>${formatMetric(style.fontSize || 14)}pt · ${formatMetric(style.fontWeight || 400)} · ${escapeHtml(style.fontFamily || 'System')}</strong></div>` : ''}
      </div>
    </div>
  `
}

function renderLayers() {
  const root = currentPreviewRoot()
  if (!root) {
    refs.layersPanel.innerHTML = ''
    return
  }
  refs.layersPanel.innerHTML = renderLayerNode(root, 0)
  refs.layersPanel.querySelectorAll('.layer-row').forEach(button => {
    button.addEventListener('click', () => {
      const node = findPreviewNode(root, button.dataset.nodeId)
      if (!node) return
      state.selectedNodeId = node.id
      renderInspector(node)
      renderLayers()
      renderPreview()
    })
  })
}

function renderLayerNode(node, depth) {
  const children = node.children?.length ? node.children : (node.previewChildren || [])
  const active = node.id === state.selectedNodeId ? ' active' : ''
  return `
    <button class="layer-row${active}" data-node-id="${escapeHtml(node.id)}" style="--depth:${depth}">
      <span class="layer-type-icon">${layerGlyph(node)}</span>
      <span class="layer-name">${escapeHtml(node.name || node.outlet || 'View')}</span>
      <small>${escapeHtml(node.kind || 'view')}</small>
    </button>
    ${children.map(child => renderLayerNode(child, depth + 1)).join('')}`
}

function findPreviewNode(root, id) {
  let found = null
  walkPreview(root, node => {
    if (!found && node.id === id) found = node
  })
  return found
}

function setInspectorTab(tab) {
  state.inspectorTab = tab === 'layers' ? 'layers' : 'inspect'
  document.querySelectorAll('.inspector-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === state.inspectorTab))
  refs.inspector.hidden = state.inspectorTab !== 'inspect'
  refs.layersPanel.hidden = state.inspectorTab !== 'layers'
  if (state.inspectorTab === 'layers') renderLayers()
}

function setZoom(value) {
  state.zoom = value
  renderPreview()
}

function nudgeZoom(delta) {
  const base = state.zoom === 'fit' ? state.lastScale : Number(state.zoom || 1)
  state.zoom = Math.max(0.2, Math.min(3, Math.round((base + delta) * 10) / 10))
  renderPreview()
}

function toggleCanvasFlag(key, button) {
  state[key] = !state[key]
  button.classList.toggle('active', state[key])
  renderPreview()
}

function togglePreviewFocus(force) {
  state.focusPreview = typeof force === 'boolean' ? force : !state.focusPreview
  document.body.classList.toggle('preview-focus-mode', state.focusPreview)
  refs.focusPreviewButton.classList.toggle('active', state.focusPreview)
  refs.focusPreviewButton.textContent = state.focusPreview ? 'Exit' : 'Focus'
  setTimeout(renderPreview, 30)
}

function renderWarnings() {
  const warnings = state.compiled?.warnings || []
  refs.warningCount.textContent = String(warnings.length)
  refs.warningsPanel.hidden = warnings.length === 0
  refs.warningsList.innerHTML = warnings.map(text => `<div class="warning-row"><span>!</span><p>${escapeHtml(text)}</p></div>`).join('')
}

async function downloadAllFiles() {
  if (!state.compiled) return
  const zip = new JSZip()
  for (const file of state.compiled.files) zip.file(file.path, file.content)
  zip.file('UIKitForge.generated.json', JSON.stringify({
    rootClass: state.compiled.rootClass,
    components: state.compiled.components,
    warnings: state.compiled.warnings,
    source: state.figmaData?.source || null
  }, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, `${state.compiled.rootClass}-UIKitForge.zip`)
}

function downloadSelectedFile() {
  const file = currentFile()
  if (!file) return
  downloadBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.name)
}

function persistToken() {
  const value = refs.figmaToken.value.trim()
  if (value) sessionStorage.setItem(SESSION_KEY, value)
  else sessionStorage.removeItem(SESSION_KEY)

  if (refs.rememberToken.checked && value) localStorage.setItem(STORAGE_KEY, value)
  else localStorage.removeItem(STORAGE_KEY)
}

function restoreToken() {
  const remembered = localStorage.getItem(STORAGE_KEY)
  const session = sessionStorage.getItem(SESSION_KEY)
  refs.figmaToken.value = remembered || session || ''
  refs.rememberToken.checked = Boolean(remembered)
}

function setStatus(message, tone = 'idle', metrics = []) {
  refs.statusText.textContent = message
  const dot = refs.statusStrip.querySelector('.status-dot')
  dot.className = `status-dot ${tone}`
  refs.statusMetrics.innerHTML = metrics.map(metric => `<span>${escapeHtml(metric)}</span>`).join('')
}

function createDemoFigmaData() {
  return {
    name: 'UIKitForge Demo',
    components: {}, componentSets: {}, styles: {}, imageMap: {},
    root: {
      id: '1:1', type: 'FRAME', name: 'Fast Data Card',
      layoutMode: 'VERTICAL', itemSpacing: 12, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 20,
      absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 314 },
      fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }], gradientStops: [
        { position: 0, color: { r: 0.97, g: 0.98, b: 1, a: 1 } },
        { position: 1, color: { r: 0.90, g: 0.94, b: 1, a: 1 } }
      ] }],
      cornerRadius: 24,
      effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 8 }, radius: 28, spread: 0, color: { r: 0.05, g: 0.1, b: 0.2, a: 0.12 } }],
      children: [
        {
          id: '1:2', type: 'TEXT', name: 'Title Label', characters: 'Gói data nổi bật',
          absoluteBoundingBox: { x: 20, y: 20, width: 250, height: 28 },
          fills: [{ type: 'SOLID', color: { r: 0.04, g: 0.07, b: 0.14, a: 1 } }],
          style: { fontSize: 22, fontWeight: 700, lineHeightPx: 28, textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT' }
        },
        {
          id: '1:3', type: 'TEXT', name: 'Description Label', characters: 'Chọn gói phù hợp với nhu cầu của bạn',
          absoluteBoundingBox: { x: 20, y: 60, width: 330, height: 20 },
          fills: [{ type: 'SOLID', color: { r: 0.35, g: 0.4, b: 0.5, a: 1 } }],
          style: { fontSize: 14, fontWeight: 400, lineHeightPx: 20, textAlignHorizontal: 'LEFT', textAutoResize: 'HEIGHT' }
        },
        {
          id: '1:4', type: 'INSTANCE', name: 'Package Card', componentId: 'cmp:package',
          absoluteBoundingBox: { x: 20, y: 100, width: 350, height: 118 },
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.92 } }],
          cornerRadius: 18,
          effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 14, spread: 0, color: { r: 0.08, g: 0.12, b: 0.25, a: 0.08 } }],
          children: [
            {
              id: '1:5', type: 'TEXT', name: 'Package Name', characters: 'VD90',
              absoluteBoundingBox: { x: 38, y: 118, width: 80, height: 24 },
              fills: [{ type: 'SOLID', color: { r: 0.08, g: 0.28, b: 0.9, a: 1 } }],
              style: { fontSize: 20, fontWeight: 700, lineHeightPx: 24, textAutoResize: 'WIDTH_AND_HEIGHT' }
            },
            {
              id: '1:6', type: 'TEXT', name: 'Allowance', characters: '1GB/ngày · 30 ngày',
              absoluteBoundingBox: { x: 38, y: 150, width: 180, height: 20 },
              fills: [{ type: 'SOLID', color: { r: 0.24, g: 0.28, b: 0.36, a: 1 } }],
              style: { fontSize: 14, fontWeight: 500, lineHeightPx: 20, textAutoResize: 'WIDTH_AND_HEIGHT' }
            },
            {
              id: '1:7', type: 'TEXT', name: 'Price', characters: '90.000đ',
              absoluteBoundingBox: { x: 265, y: 128, width: 82, height: 24 },
              fills: [{ type: 'SOLID', color: { r: 0.06, g: 0.09, b: 0.15, a: 1 } }],
              style: { fontSize: 17, fontWeight: 700, lineHeightPx: 24, textAlignHorizontal: 'RIGHT', textAutoResize: 'WIDTH_AND_HEIGHT' }
            }
          ]
        },
        {
          id: '1:8', type: 'FRAME', name: 'CTA Button',
          absoluteBoundingBox: { x: 20, y: 238, width: 350, height: 56 },
          fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], gradientStops: [
            { position: 0, color: { r: 0.12, g: 0.36, b: 0.98, a: 1 } },
            { position: 1, color: { r: 0.32, g: 0.22, b: 0.94, a: 1 } }
          ] }],
          cornerRadius: 18,
          children: [{
            id: '1:9', type: 'TEXT', name: 'CTA Title', characters: 'Đăng ký ngay',
            absoluteBoundingBox: { x: 143, y: 256, width: 104, height: 20 },
            fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
            style: { fontSize: 15, fontWeight: 600, lineHeightPx: 20, textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' }
          }]
        }
      ]
    }
  }
}

function layerGlyph(node) {
  const kind = node.kind || node.type
  if (kind === 'label' || node.type === 'TEXT') return 'T'
  if (kind === 'image') return '▧'
  if (kind === 'component') return '◇'
  return '□'
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function shortValue(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatMetric(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Number(number.toFixed(2)).toString() : String(value ?? '—')
}

function debounce(fn, delay) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}
