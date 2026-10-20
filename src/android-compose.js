import { formatNumber, isSystemFontFamily, parseRgba } from './compiler-core.js'

const DEFAULT_ANDROID_NAMESPACE = 'com.example.app'

export function androidResourceName(value) {
  const normalized = String(value || 'asset')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(normalized) ? normalized : `asset_${normalized || 'generated'}`
}

export async function addAndroidImageAssets(zip, { assets = [], refs = [], nodeImageExports = {}, imageMap = {} } = {}) {
  const warnings = []
  const seen = new Map()
  const reserve = (outlet, identity = outlet, resourceName = outlet) => {
    const name = androidResourceName(resourceName)
    if (seen.has(name) && seen.get(name) !== identity) {
      warnings.push(`${outlet}: Android image resource name collides after sanitization.`)
      return null
    }
    seen.set(name, identity)
    return name
  }
  const addDataUrl = (outlet, dataUrl) => {
    const mime = String(dataUrl).slice(5, String(dataUrl).indexOf(';'))
    const ext = imageExtension(mime)
    const payload = String(dataUrl).split(',')[1]
    if (!ext || !payload) {
      warnings.push(`${outlet}: unsupported Android image format.`)
      return
    }
    const name = reserve(outlet, outlet)
    if (name) zip.file(`Android/src/main/res/drawable-nodpi/${name}.${ext}`, payload, { base64: true })
  }
  for (const asset of assets) if (asset?.dataUrl) addDataUrl(asset.name, asset.dataUrl)

  const addRemote = async (outlet, identity, url, directory, resourceName = outlet) => {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        warnings.push(`${outlet}: HTTP ${response.status} while downloading Android image.`)
        return false
      }
      const blob = await response.blob()
      const ext = imageExtension(blob.type)
      if (!ext) {
        warnings.push(`${outlet}: unsupported Android image format.`)
        return false
      }
      const name = reserve(outlet, identity, resourceName)
      if (!name) return false
      zip.file(`Android/src/main/res/${directory}/${name}.${ext}`, blob)
      return true
    } catch {
      warnings.push(`${outlet}: Android image request failed.`)
      return false
    }
  }

  for (const { outlet, assetName, figmaId, imageRef } of refs) {
    if (!outlet) continue
    const resourceName = assetName || outlet
    if (imageRef) {
      const url = imageMap[imageRef]
      if (!url) warnings.push(`${outlet}: Figma image fill URL is unavailable.`)
      else await addRemote(outlet, imageRef, url, 'drawable-nodpi', resourceName)
      continue
    }
    const urls = nodeImageExports[figmaId]
    if (!urls || (!urls['2x'] && !urls['3x'])) {
      warnings.push(`${outlet}: Figma image export URL is unavailable.`)
      continue
    }
    for (const [scale, density] of [['2x', 'drawable-xhdpi'], ['3x', 'drawable-xxhdpi']]) {
      if (urls[scale]) await addRemote(outlet, figmaId || outlet, urls[scale], density, resourceName)
    }
  }
  return warnings
}

function imageExtension(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(mime || '').toLowerCase()] || null
}

export function generateAndroidComposeFiles({
  rootClass,
  mainIR,
  componentIRs = [],
  scroll = null,
  androidNamespace = DEFAULT_ANDROID_NAMESPACE
}) {
  if (!mainIR) return []
  if (!isValidAndroidNamespace(androidNamespace)) {
    throw new Error('Android namespace must be a dotted Java package name.')
  }

  const packageName = `${androidNamespace}.uikitforge.generated`
  const folder = `Android/src/main/java/${packageName.replaceAll('.', '/')}`
  const screenName = kotlinName(rootClass || 'GeneratedView')
  const componentParameterNames = new Map((componentIRs || []).map(({ className, ir }) => [className, slotParameterNames(ir.slots || [])]))
  const ctx = { textSlots: new Map(), hiddenSlots: new Map(), componentParameterNames }
  const screen = androidFile(
    `${folder}/${screenName}.kt`,
    screenName,
    renderScreen(screenName, mainIR, ctx, scroll, androidNamespace),
    'main'
  )
  const components = (componentIRs || []).map(({ className, ir }) => androidFile(
    `${folder}/Components/${kotlinName(className)}.kt`,
    `${kotlinName(className)}.kt`,
    renderComponent(kotlinName(className), ir, androidNamespace, componentParameterNames),
    'component'
  ))
  return [screen, ...components]
}

function androidFile(path, name, content, kind) {
  return { path, name, language: 'kotlin', content, kind, target: 'android-compose' }
}

function renderScreen(name, root, ctx, scroll, namespace) {
  const body = renderNode(root, ctx, { root: true, modifier: scroll ? 'Modifier' : 'modifier' })
  const content = scroll
    ? [
        `Column(modifier = modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {`,
        indent(body, 1),
        '}'
      ].join('\n')
    : body
  return `${fileHeader(namespace)}

@Composable
fun ${name}(modifier: Modifier = Modifier) {
${indent(content, 1)}
}
`
}

function renderComponent(name, root, namespace, componentParameterNames) {
  const slots = root.slots || []
  const parameterNames = slotParameterNames(slots)
  const ctx = {
    textSlots: new Map(slots.filter(slot => slot.kind === 'text').map(slot => [slot.nodeId, parameterNames.get(slot.param)])),
    hiddenSlots: new Map(slots.filter(slot => slot.kind === 'hidden').map(slot => [slot.nodeId, slot.shows ? parameterNames.get(slot.param) : `!${parameterNames.get(slot.param)}`])),
    componentParameterNames
  }
  const parameters = slots.map(slot => slot.kind === 'text'
    ? `${parameterNames.get(slot.param)}: String = ${kotlinString(slot.fallback)}`
    : `${parameterNames.get(slot.param)}: Boolean = ${String(Boolean(slot.fallback))}`)
  parameters.push('modifier: Modifier = Modifier')
  const body = renderNode(root, ctx, { root: true, modifier: 'modifier' })
  return `${fileHeader(namespace)}

@Composable
fun ${name}(${parameters.join(', ')}) {
${indent(body, 1)}
}
`
}

function fileHeader(namespace) {
  return `package ${namespace}.uikitforge.generated

import ${namespace}.R
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp`
}

function renderNode(node, ctx, { root = false, modifier = 'Modifier', placement = 'box', stack = null, skipHidden = null } = {}) {
  if (!node) return 'Spacer(modifier = Modifier.size(0.dp))'
  const condition = ctx.hiddenSlots?.get(node.id)
  if (!root && condition && skipHidden !== node.id) {
    return `if (${condition}) {\n${indent(renderNode(node, ctx, { root, modifier, placement, stack, skipHidden: node.id }), 1)}\n}`
  }

  const nodeModifier = modifierFor(node, { root, modifier, placement, stack })
  if (node.kind === 'label') return renderLabel(node, ctx, nodeModifier)
  if (node.kind === 'image') return renderImage(node, nodeModifier)
  if (node.kind === 'component') return renderComponentCall(node, nodeModifier, ctx)

  const children = node.children || []
  const body = node.stack ? renderStack(node, children, ctx) : children
    .map(child => renderNode(child, ctx, { placement: 'box' }))
    .join('\n')
  const backgroundImage = node.style?.backgroundImage
    ? `Image(painter = painterResource(id = R.drawable.${androidResourceName(node.backgroundAssetName || `${node.outlet}Background`)}), contentDescription = null, contentScale = ${imageScale(node.style.backgroundImage.scaleMode)}, modifier = Modifier.matchParentSize())`
    : ''
  return `Box(modifier = ${nodeModifier}) {\n${indent([backgroundImage, body].filter(Boolean).join('\n'), 1)}\n}`
}

function renderStack(node, children, ctx) {
  const { stack } = node
  const horizontal = stack.axis === 'horizontal'
  const arranged = children.filter(child => child.arranged)
  const pinned = children.filter(child => !child.arranged)
  const padding = stackPadding(node)
  const layoutModifier = `Modifier${padding}`
  const layout = horizontal ? 'Row' : 'Column'
  const arrangement = stack.distribution === 'equalSpacing'
    ? `Arrangement.${horizontal ? 'SpaceBetween' : 'SpaceBetween'}`
    : `Arrangement.spacedBy(${formatNumber(stack.spacing)}.dp)`
  const crossAlignment = horizontal
    ? `verticalAlignment = Alignment.${{ center: 'CenterVertically', bottom: 'Bottom' }[stack.alignment] || 'Top'}`
    : `horizontalAlignment = Alignment.${{ center: 'CenterHorizontally', trailing: 'End' }[stack.alignment] || 'Start'}`
  const main = `${layout}(modifier = ${layoutModifier}, ${horizontal ? 'horizontalArrangement' : 'verticalArrangement'} = ${arrangement}, ${crossAlignment}) {\n${indent(arranged.map(child => renderNode(child, ctx, { placement: 'stack', stack } )).join('\n'), 1)}\n}`
  return [main, ...pinned.map(child => renderNode(child, ctx, { placement: 'box' }))].filter(Boolean).join('\n')
}

function renderLabel(node, ctx, modifier) {
  const text = ctx.textSlots?.get(node.id) ?? (node.textRuns?.length ? textRuns(node) : kotlinString(node.text))
  const style = node.style || {}
  const textStyle = [
    `fontSize = ${formatNumber(style.fontSize || 14)}.sp`,
    `fontWeight = FontWeight(${Math.round(style.fontWeight || 400)})`,
    ...(style.textColor ? [`color = ${composeColor(style.textColor)}`] : []),
    `textAlign = TextAlign.${{ center: 'Center', right: 'End', justified: 'Justify' }[style.textAlign] || 'Start'}`,
    ...(style.lineHeight > 0 ? [`lineHeight = ${formatNumber(style.lineHeight)}.sp`] : []),
    ...(style.letterSpacing ? [`letterSpacing = ${formatNumber(style.letterSpacing)}.sp`] : []),
    ...(!isSystemFontFamily(style.fontFamily) ? ['fontFamily = FontFamily.SansSerif'] : [])
  ]
  const maxLines = style.numberOfLines === 1 ? '1' : 'Int.MAX_VALUE'
  const decoration = style.textDecoration === 'UNDERLINE' ? 'TextDecoration.Underline'
    : style.textDecoration === 'STRIKETHROUGH' ? 'TextDecoration.LineThrough' : null
  if (decoration) textStyle.push(`textDecoration = ${decoration}`)
  return `BasicText(text = ${text}, modifier = ${modifier}, style = TextStyle(${textStyle.join(', ')}), maxLines = ${maxLines}, overflow = TextOverflow.Clip)`
}

function textRuns(node) {
  const lines = (node.textRuns || []).map(run => {
    const styles = [
      run.fontWeight != null && run.fontWeight !== node.style?.fontWeight ? `fontWeight = FontWeight(${Math.round(run.fontWeight)})` : null,
      run.color && run.color !== node.style?.textColor ? `color = ${composeColor(run.color)}` : null,
      run.decoration === 'UNDERLINE' ? 'textDecoration = TextDecoration.Underline'
        : run.decoration === 'STRIKETHROUGH' ? 'textDecoration = TextDecoration.LineThrough' : null
    ].filter(Boolean)
    const append = `append(${kotlinString(run.text)})`
    return styles.length ? `withStyle(SpanStyle(${styles.join(', ')})) { ${append} }` : append
  })
  return `buildAnnotatedString {\n${indent(lines.join('\n'), 1)}\n}`
}

function renderImage(node, modifier) {
  return `Image(painter = painterResource(id = R.drawable.${androidResourceName(node.assetName || node.outlet)}), contentDescription = ${node.name ? kotlinString(node.name) : 'null'}, contentScale = ${imageScale(node.style?.imageScaleMode)}, modifier = ${modifier})`
}

function renderComponentCall(node, modifier, ctx) {
  const names = ctx.componentParameterNames?.get(node.className) || new Map()
  const args = (node.overrides || []).map(({ slot, value }) => `${names.get(slot.param) || kotlinIdentifier(slot.param)} = ${slot.kind === 'text' ? kotlinString(value) : String(Boolean(value))}`)
  args.push(`modifier = ${modifier}`)
  return `${kotlinName(node.className)}(${args.join(', ')})`
}

function modifierFor(node, { root, modifier, placement, stack }) {
  const frame = node.frame || {}
  const sizing = node.sizing || {}
  const parts = [modifier]
  if (root) {
    parts.push('fillMaxWidth()', `height(${formatNumber(frame.height || 0)}.dp)`)
  } else if (placement === 'box') {
    if (frame.x || frame.y) parts.push(`offset(x = ${formatNumber(frame.x)}.dp, y = ${formatNumber(frame.y)}.dp)`)
    if (sizing.h === 'FILL') parts.push('fillMaxWidth()')
    else if (frame.width > 0) parts.push(`width(${formatNumber(frame.width)}.dp)`)
    if (sizing.v === 'FILL') parts.push('fillMaxHeight()')
    else if (frame.height > 0 && node.kind !== 'label') parts.push(`height(${formatNumber(frame.height)}.dp)`)
  } else if (placement === 'stack') {
    const mainAxis = stack.axis === 'horizontal' ? 'h' : 'v'
    const crossAxis = mainAxis === 'h' ? 'v' : 'h'
    if (sizing[mainAxis] === 'FILL') parts.push('weight(1f)')
    else if (sizing[mainAxis] === 'FIXED') parts.push(`${mainAxis === 'h' ? 'width' : 'height'}(${formatNumber(frame[mainAxis === 'h' ? 'width' : 'height'])}.dp)`)
    if (sizing[crossAxis] === 'FILL' || stack.alignment === 'fill') parts.push(`${crossAxis === 'h' ? 'fillMaxWidth' : 'fillMaxHeight'}()`)
    else if (sizing[crossAxis] === 'FIXED') parts.push(`${crossAxis === 'h' ? 'width' : 'height'}(${formatNumber(frame[crossAxis === 'h' ? 'width' : 'height'])}.dp)`)
  }

  const style = node.style || {}
  const shape = style.cornerRadii
    ? `RoundedCornerShape(topStart = ${formatNumber(style.cornerRadii[0])}.dp, topEnd = ${formatNumber(style.cornerRadii[1])}.dp, bottomEnd = ${formatNumber(style.cornerRadii[2])}.dp, bottomStart = ${formatNumber(style.cornerRadii[3])}.dp)`
    : `RoundedCornerShape(${formatNumber(style.radius || 0)}.dp)`
  if ((node.meta?.clipsContent || node.kind === 'image') && style.radius > 0) parts.push(`clip(${shape})`)
  if (style.gradient) parts.push(`background(${composeBrush(style.gradient)})`)
  else if (style.background) parts.push(`background(${composeColor(style.background)}, ${shape})`)
  if (style.borderColor && style.borderWidth > 0) parts.push(`border(${formatNumber(style.borderWidth)}.dp, ${composeColor(style.borderColor)}, ${shape})`)
  if (style.shadow?.blur > 0) parts.push(`shadow(${formatNumber(style.shadow.blur)}.dp, ${shape})`)
  if (style.opacity < 1) parts.push(`alpha(${formatNumber(style.opacity)}f)`)
  return parts.join('.').replace(/^Modifier\./, 'Modifier.')
}

function stackPadding(node) {
  const frame = node.stack.frame
  const insets = {
    start: frame.x,
    top: frame.y,
    end: node.frame.width - frame.x - frame.width,
    bottom: node.frame.height - frame.y - frame.height
  }
  const values = Object.entries(insets).filter(([, value]) => value > 0)
  return values.length ? `.padding(${values.map(([edge, value]) => `${edge} = ${formatNumber(value)}.dp`).join(', ')})` : ''
}

function composeBrush(gradient) {
  const stops = gradient.stops.map(stop => `${formatNumber(stop.position)}f to ${composeColor(stop.rgba)}`)
  const kind = gradient.type === 'radial' ? 'radialGradient' : gradient.type === 'angular' ? 'sweepGradient' : 'linearGradient'
  return `Brush.${kind}(${stops.join(', ')})`
}

function composeColor(value) {
  const color = parseRgba(value) || { r: 0, g: 0, b: 0, a: 1 }
  const channel = part => Math.max(0, Math.min(255, Math.round(part * 255))).toString(16).padStart(2, '0')
  return `Color(0x${channel(color.a)}${channel(color.r)}${channel(color.g)}${channel(color.b)})`
}

function imageScale(mode) {
  return mode === 'FILL' ? 'ContentScale.Crop' : mode === 'STRETCH' ? 'ContentScale.FillBounds' : 'ContentScale.Fit'
}

function kotlinName(value) {
  const name = String(value || 'GeneratedView').replace(/[^A-Za-z0-9_]/g, '')
  const leading = name.replace(/^[^A-Za-z]+/, '') || 'GeneratedView'
  return `${leading[0].toUpperCase()}${leading.slice(1)}`
}

const KOTLIN_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while'])

function isValidAndroidNamespace(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value) && value.split('.').every(part => !KOTLIN_KEYWORDS.has(part))
}

function slotParameterNames(slots) {
  const used = new Set(['modifier'])
  return new Map(slots.map(slot => {
    const base = kotlinIdentifier(slot.param)
    let name = base
    for (let suffix = 2; used.has(name) || KOTLIN_KEYWORDS.has(name); suffix++) name = `${base}Value${suffix}`
    if (KOTLIN_KEYWORDS.has(name)) name = `${name}Value`
    used.add(name)
    return [slot.param, name]
  }))
}

function kotlinIdentifier(value) {
  let name = String(value || 'value').replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`
  return KOTLIN_KEYWORDS.has(name) || name === 'modifier' ? `${name}Value` : name
}

function kotlinString(value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

function indent(value, depth) {
  return String(value).split('\n').map(line => `${'    '.repeat(depth)}${line}`).join('\n')
}
