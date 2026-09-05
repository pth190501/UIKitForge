import JSZip from 'jszip'
import './styles.css'
import { fetchFigmaSelection, parseFigmaUrl, summarizeFigmaTree } from './figma.js'
import { compileUIKit } from './compiler.js'
import { applySwiftPreview, describeNode, renderUIKitPreview } from './preview.js'

const STORAGE_KEY = 'uikitforge.figmaToken'
const SESSION_KEY = 'uikitforge.figmaToken.session'

const state = {
  figmaData: null,
  compiled: null,
  selectedFileIndex: -1,
  selectedNodeId: null,
  referenceImage: null,
  overlayOpacity: 0,
  generating: false
}

const app = document.querySelector('#app')
app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-wrap">
        <div class="brand-mark">UF</div>
        <div>
          <h1>UIKitForge</h1>
          <p>Figma → UIKit Swift + XIB Compiler</p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="button ghost" id="demoButton">Load demo</button>
        <button class="button ghost" id="downloadFileButton" disabled>Download file</button>
        <button class="button primary" id="downloadAllButton" disabled>Export ZIP</button>
      </div>
    </header>

    <section class="source-panel">
      <div class="field figma-url-field">
        <label for="figmaUrl">Figma URL</label>
        <input id="figmaUrl" type="url" placeholder="https://www.figma.com/design/...?...node-id=..." autocomplete="off" />
      </div>
      <div class="field root-class-field">
        <label for="rootClass">Root class</label>
        <input id="rootClass" type="text" value="GeneratedView" spellcheck="false" />
      </div>
      <div class="field token-field">
        <label for="figmaToken">Figma token</label>
        <div class="token-row">
          <input id="figmaToken" type="password" placeholder="figd_..." autocomplete="off" />
          <button class="icon-button" id="toggleToken" title="Show/hide token">◉</button>
          <button class="icon-button danger-text" id="forgetToken" title="Forget token">×</button>
        </div>
        <label class="check-row"><input id="rememberToken" type="checkbox" /> Remember on this device</label>
      </div>
      <div class="field reference-field">
        <label for="referenceImage">Reference image <span>optional</span></label>
        <input id="referenceImage" type="file" accept="image/*" />
      </div>
      <button class="button generate" id="generateButton">Generate UIKit</button>
    </section>

    <section class="status-strip" id="statusStrip">
      <span class="status-dot idle"></span>
      <span id="statusText">Paste a Figma node URL and token, or load the built-in demo.</span>
      <div class="status-metrics" id="statusMetrics"></div>
    </section>

    <section class="workspace">
      <aside class="files-panel panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">OUTPUT</span>
            <h2>Files</h2>
          </div>
          <span class="count-pill" id="fileCount">0</span>
        </div>
        <div class="files-list empty-state" id="filesList">Generated .swift and .xib files will appear here.</div>
      </aside>

      <section class="editor-panel panel">
        <div class="panel-header editor-header">
          <div>
            <span class="eyebrow" id="editorLanguage">EDITOR</span>
            <h2 id="editorFilename">No file selected</h2>
          </div>
          <span class="live-pill" id="livePill">LIVE PREVIEW</span>
        </div>
        <textarea id="codeEditor" class="code-editor" spellcheck="false" disabled placeholder="Generate UIKit to start editing..."></textarea>
        <div class="editor-footer" id="editorFooter">Swift style changes in the generated main view are mirrored instantly in Browser Preview.</div>
      </section>

      <section class="preview-panel panel">
        <div class="panel-header preview-header">
          <div>
            <span class="eyebrow">BROWSER PREVIEW</span>
            <h2 id="previewTitle">UIKit layout</h2>
          </div>
          <div class="overlay-controls">
            <label for="overlayRange">Reference</label>
            <input id="overlayRange" type="range" min="0" max="100" value="0" />
            <span id="overlayValue">0%</span>
          </div>
        </div>
        <div class="preview-canvas" id="previewCanvas">
          <div class="preview-empty">
            <div class="phone-icon"></div>
            <strong>No preview yet</strong>
            <span>Generate from Figma or load the demo.</span>
          </div>
        </div>
      </section>

      <aside class="inspector-panel panel">
        <div class="panel-header">
          <div>
            <span class="eyebrow">INSPECTOR</span>
            <h2>Selection</h2>
          </div>
        </div>
        <div id="inspector" class="inspector empty-state">Click a view in Preview to inspect its frame, style and inferred Auto Layout constraints.</div>
      </aside>
    </section>

    <section class="warnings-panel panel" id="warningsPanel" hidden>
      <div class="panel-header">
        <div>
          <span class="eyebrow">COMPILER NOTES</span>
          <h2>Warnings</h2>
        </div>
        <span class="count-pill warning" id="warningCount">0</span>
      </div>
      <div id="warningsList" class="warning-list"></div>
    </section>

    <footer>
      <span>UIKitForge MVP · Token stays in your browser unless you choose Remember.</span>
      <span>Browser Preview is fast approximation. Native Xcode validation is Phase 2.</span>
    </footer>
  </main>
`

const refs = Object.fromEntries([
  'figmaUrl', 'rootClass', 'figmaToken', 'toggleToken', 'forgetToken', 'rememberToken', 'referenceImage',
  'generateButton', 'demoButton', 'downloadFileButton', 'downloadAllButton', 'statusText', 'statusMetrics',
  'statusStrip', 'fileCount', 'filesList', 'editorLanguage', 'editorFilename', 'codeEditor', 'editorFooter',
  'previewCanvas', 'previewTitle', 'overlayRange', 'overlayValue', 'inspector', 'warningsPanel', 'warningCount', 'warningsList'
].map(id => [id, document.getElementById(id)]))

restoreToken()
wireEvents()

function wireEvents() {
  refs.generateButton.addEventListener('click', generateFromFigma)
  refs.demoButton.addEventListener('click', loadDemo)

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
    renderPreview()
  })

  refs.overlayRange.addEventListener('input', () => {
    state.overlayOpacity = Number(refs.overlayRange.value) / 100
    refs.overlayValue.textContent = `${refs.overlayRange.value}%`
    renderPreview()
  })

  refs.codeEditor.addEventListener('input', () => {
    const file = state.compiled?.files?.[state.selectedFileIndex]
    if (!file) return
    file.content = refs.codeEditor.value
    if (file.language === 'swift' && file.kind === 'main') renderPreview()
    updateEditorFooter(file)
  })

  refs.downloadFileButton.addEventListener('click', downloadSelectedFile)
  refs.downloadAllButton.addEventListener('click', downloadAllFiles)

  window.addEventListener('resize', debounce(renderPreview, 100))
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
  refs.generateButton.textContent = 'Reading Figma…'
  setStatus('Reading the selected Figma node…', 'loading')
  persistToken()

  try {
    const figmaData = await fetchFigmaSelection({ figmaUrl, token })
    setStatus('Figma loaded. Compiling UIKit hierarchy…', 'loading')
    const compiled = compileUIKit(figmaData, rootClass)
    state.figmaData = figmaData
    state.compiled = compiled
    state.selectedNodeId = null
    renderWorkspace()

    const summary = summarizeFigmaTree(figmaData.root)
    setStatus(`Generated ${compiled.rootClass} from Figma.`, 'success', [
      `${summary.nodes} nodes`,
      `${compiled.components.length} components`,
      `${compiled.files.length} files`
    ])
  } catch (error) {
    console.error(error)
    setStatus(error.message || 'Generation failed.', 'error')
  } finally {
    state.generating = false
    refs.generateButton.disabled = false
    refs.generateButton.textContent = 'Generate UIKit'
  }
}

function loadDemo() {
  const figmaData = createDemoFigmaData()
  const compiled = compileUIKit(figmaData, 'V5FastDataCardView')
  state.figmaData = figmaData
  state.compiled = compiled
  state.selectedNodeId = null
  refs.rootClass.value = compiled.rootClass
  renderWorkspace()
  setStatus('Demo generated. Try editing cornerRadius, colors, text or font size in the Swift file.', 'success', [
    `${compiled.components.length} component`,
    `${compiled.files.length} files`,
    'Live Swift preview'
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
    const group = file.kind === 'main' ? 'Main view' : 'Components'
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
    button.innerHTML = `<span class="file-icon ${file.language}">${file.language === 'swift' ? 'S' : 'X'}</span><span class="file-meta"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span>`
    button.addEventListener('click', () => selectFile(index))
    refs.filesList.appendChild(button)
  })
}

function selectFile(index) {
  const file = state.compiled?.files?.[index]
  if (!file) return

  state.selectedFileIndex = index
  document.querySelectorAll('.file-row').forEach(row => row.classList.toggle('active', Number(row.dataset.index) === index))
  refs.editorFilename.textContent = file.name
  refs.editorLanguage.textContent = file.language === 'swift' ? 'SWIFT' : 'XIB XML'
  refs.codeEditor.disabled = false
  refs.codeEditor.value = file.content
  refs.downloadFileButton.disabled = false
  updateEditorFooter(file)

  if (file.kind === 'main') {
    refs.previewTitle.textContent = state.compiled.rootClass
    renderPreview()
  }
}

function updateEditorFooter(file) {
  if (file.language === 'swift' && file.kind === 'main') {
    refs.editorFooter.textContent = 'Live: common UIKit assignments are parsed from this Swift file and mirrored into Browser Preview as you type.'
    refs.editorFooter.classList.add('live')
  } else if (file.language === 'swift') {
    refs.editorFooter.textContent = 'Component Swift is generated and editable. Isolated component hot-preview is the next MVP increment; the main Swift file is live now.'
    refs.editorFooter.classList.remove('live')
  } else {
    refs.editorFooter.textContent = 'XIB XML is editable. Browser Preview currently follows the compiler IR + live Swift style changes; native XIB re-rendering is Phase 2.'
    refs.editorFooter.classList.remove('live')
  }
}

function renderPreview() {
  if (!state.compiled?.previewRoot) return
  const mainSwift = state.compiled.files.find(file => file.kind === 'main' && file.language === 'swift')
  const previewRoot = mainSwift ? applySwiftPreview(state.compiled.previewRoot, mainSwift.content) : state.compiled.previewRoot
  renderUIKitPreview(refs.previewCanvas, previewRoot, {
    selectedId: state.selectedNodeId,
    referenceImage: state.referenceImage,
    overlayOpacity: state.overlayOpacity,
    onSelect: node => {
      state.selectedNodeId = node.id
      renderInspector(node)
      renderPreview()
    }
  })
}

function renderInspector(node) {
  const detail = describeNode(node)
  if (!detail) return
  const constraints = detail.constraints.length
    ? detail.constraints.map(item => `<li><span>${escapeHtml(item.type)}</span><strong>${formatMetric(item.constant)}</strong></li>`).join('')
    : '<li><span>Root view</span><strong>—</strong></li>'

  refs.inspector.classList.remove('empty-state')
  refs.inspector.innerHTML = `
    <div class="inspector-title">
      <strong>${escapeHtml(detail.name)}</strong>
      <span>${escapeHtml(detail.kind)}${detail.className ? ` · ${escapeHtml(detail.className)}` : ''}</span>
    </div>
    <div class="inspector-section">
      <h3>Outlet</h3>
      <code>${escapeHtml(detail.outlet)}</code>
    </div>
    <div class="inspector-section">
      <h3>Frame</h3>
      <div class="metric-grid">
        <span>x <b>${formatMetric(detail.frame.x)}</b></span>
        <span>y <b>${formatMetric(detail.frame.y)}</b></span>
        <span>w <b>${formatMetric(detail.frame.width)}</b></span>
        <span>h <b>${formatMetric(detail.frame.height)}</b></span>
      </div>
    </div>
    <div class="inspector-section">
      <h3>Auto Layout</h3>
      <ul class="constraint-list">${constraints}</ul>
    </div>
    <div class="inspector-section">
      <h3>Style</h3>
      <div class="style-summary">
        <span>radius <b>${formatMetric(detail.style.radius || 0)}</b></span>
        <span>opacity <b>${formatMetric(detail.style.opacity ?? 1)}</b></span>
        ${detail.kind === 'label' ? `<span>font <b>${formatMetric(detail.style.fontSize || 14)}pt</b></span>` : ''}
      </div>
    </div>
  `
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
    warnings: state.compiled.warnings
  }, null, 2))

  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, `${state.compiled.rootClass}-UIKitForge.zip`)
}

function downloadSelectedFile() {
  const file = state.compiled?.files?.[state.selectedFileIndex]
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
    components: {},
    componentSets: {},
    styles: {},
    root: {
      id: '1:1', type: 'FRAME', name: 'Fast Data Card',
      absoluteBoundingBox: { x: 0, y: 0, width: 361, height: 228 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      cornerRadius: 20,
      children: [
        {
          id: '1:2', type: 'TEXT', name: 'Title Label', characters: 'Gói data nổi bật',
          absoluteBoundingBox: { x: 20, y: 20, width: 240, height: 24 },
          fills: [{ type: 'SOLID', color: { r: 0.06, g: 0.08, b: 0.12, a: 1 } }],
          style: { fontSize: 20, fontWeight: 700, lineHeightPx: 24, textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT' },
          constraints: { horizontal: 'LEFT', vertical: 'TOP' }
        },
        {
          id: '1:3', type: 'TEXT', name: 'Description Label', characters: 'Chọn gói phù hợp với nhu cầu của bạn',
          absoluteBoundingBox: { x: 20, y: 54, width: 310, height: 20 },
          fills: [{ type: 'SOLID', color: { r: 0.38, g: 0.42, b: 0.5, a: 1 } }],
          style: { fontSize: 14, fontWeight: 400, lineHeightPx: 20, textAlignHorizontal: 'LEFT', textAutoResize: 'HEIGHT' },
          constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' }
        },
        {
          id: '1:4', type: 'INSTANCE', name: 'Package Card', componentId: 'cmp:package',
          absoluteBoundingBox: { x: 20, y: 94, width: 321, height: 70 },
          fills: [{ type: 'SOLID', color: { r: 0.96, g: 0.97, b: 1, a: 1 } }],
          cornerRadius: 14,
          constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' },
          children: [
            {
              id: '1:5', type: 'TEXT', name: 'Package Name Label', characters: 'VD90',
              absoluteBoundingBox: { x: 36, y: 108, width: 80, height: 22 },
              fills: [{ type: 'SOLID', color: { r: 0.08, g: 0.24, b: 0.86, a: 1 } }],
              style: { fontSize: 18, fontWeight: 700, lineHeightPx: 22, textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT' },
              constraints: { horizontal: 'LEFT', vertical: 'TOP' }
            },
            {
              id: '1:6', type: 'TEXT', name: 'Price Label', characters: '90.000đ / 30 ngày',
              absoluteBoundingBox: { x: 36, y: 136, width: 180, height: 18 },
              fills: [{ type: 'SOLID', color: { r: 0.15, g: 0.18, b: 0.24, a: 1 } }],
              style: { fontSize: 13, fontWeight: 500, lineHeightPx: 18, textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT' },
              constraints: { horizontal: 'LEFT', vertical: 'TOP' }
            }
          ]
        },
        {
          id: '1:7', type: 'FRAME', name: 'CTA Button',
          absoluteBoundingBox: { x: 20, y: 180, width: 321, height: 40 },
          fills: [{ type: 'SOLID', color: { r: 0.08, g: 0.34, b: 0.95, a: 1 } }],
          cornerRadius: 20,
          constraints: { horizontal: 'LEFT_RIGHT', vertical: 'BOTTOM' },
          children: [
            {
              id: '1:8', type: 'TEXT', name: 'CTA Title Label', characters: 'Đăng ký ngay',
              absoluteBoundingBox: { x: 131, y: 190, width: 100, height: 20 },
              fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
              style: { fontSize: 14, fontWeight: 600, lineHeightPx: 20, textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' },
              constraints: { horizontal: 'CENTER', vertical: 'CENTER' }
            }
          ]
        }
      ]
    }
  }
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
