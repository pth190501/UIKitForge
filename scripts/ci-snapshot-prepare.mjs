// Dựng Swift package chạy trên iOS Simulator để render code UIKit-Code sinh ra thành PNG và so pixel với ảnh Figma thật.
// - Mỗi fixture là 1 module (cùng tên class GeneratedView không đụng nhau), kèm Colors.xcassets + ảnh export từ Figma.
// - Có FIGMA_TOKEN: tải ảnh tham chiếu (use_absolute_bounds → đúng khung, không kèm vùng bóng) và ảnh icon/raster.
//   Không có token: vẫn render + upload ảnh, bỏ qua phần so sánh (test ghi "no reference").
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compileUIKit } from '../src/compiler.js'
import * as fixtures from '../tests/fixtures.mjs'

const OUT = 'ci-snapshot'
// Fixture lấy từ file Figma thật → có node gốc để tải ảnh tham chiếu. Fixture tổng hợp chỉ render (không có tham chiếu).
const SNAPSHOTS = [
  { fixture: 'banGoiNgayScreen', figma: { fileKey: 'zlEC3PlD37tAJLFbdUGCnm', nodeId: '34715:42593' } },
  { fixture: 'fidelityScreen' },
  { fixture: 'textStylingScreen' }
]
const token = process.env.FIGMA_TOKEN || ''

rmSync(OUT, { recursive: true, force: true })
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

async function figmaImages(fileKey, ids, extra = '') {
  if (!token || !ids.length) return {}
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=png${extra}`
  const response = await fetch(url, { headers: { 'X-Figma-Token': token } })
  if (!response.ok) throw new Error(`Figma images ${response.status}: ${await response.text()}`)
  return (await response.json()).images || {}
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function colorSet(rgba) {
  const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number)
  const components = { red: (r / 255).toFixed(3), green: (g / 255).toFixed(3), blue: (b / 255).toFixed(3), alpha: a.toFixed(3) }
  return JSON.stringify({ colors: [{ idiom: 'universal', color: { 'color-space': 'srgb', components } }], info: { author: 'UIKitForge', version: 1 } }, null, 2)
}

// Code sinh ra dùng UIColor(named:)/UIImage(named:) (bundle chính của app). Trong package, asset nằm ở Bundle.module.
function useModuleBundle(swift) {
  return swift
    .replace(/UIColor\(named: ("[^"]*")\)/g, 'UIColor(named: $1, in: .module, compatibleWith: nil)')
    .replace(/UIImage\(named: ("[^"]*")\)/g, 'UIImage(named: $1, in: .module, compatibleWith: nil)')
}

function imageNodes(compiled) {
  const nodes = []
  const walk = node => {
    if (!node) return
    if (node.kind === 'image' && node.figmaId) nodes.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(compiled.previewRoot)
  for (const { ir } of compiled.componentIRs || []) walk(ir)
  return nodes
}

const targets = []
const tests = []
for (const { fixture, figma } of SNAPSHOTS) {
  const compiled = compileUIKit(fixtures[fixture], 'GeneratedView', { deploymentTarget: 16 })
  const module = `Fixture_${fixture}`
  const dir = join(OUT, 'Sources', module)
  for (const file of compiled.files.filter(item => item.target === 'uikit-code' && item.language === 'swift')) {
    write(join(dir, file.path.replace(/^UIKit-Code\//, '')), useModuleBundle(file.content))
  }
  const assets = join(dir, 'Assets.xcassets')
  write(join(assets, 'Contents.json'), JSON.stringify({ info: { author: 'UIKitForge', version: 1 } }))
  for (const { name, rgba } of compiled.colors) write(join(assets, `${name}.colorset`, 'Contents.json'), colorSet(rgba))

  let reference = false
  if (figma && token) {
    try {
      // Ảnh icon/raster (@2x) — thiếu thì view vẫn render, chỉ mất ảnh (giống app chưa thêm asset).
      const nodes = imageNodes(compiled)
      const urls = await figmaImages(figma.fileKey, [...new Set(nodes.map(node => node.figmaId))], '&scale=2')
      for (const node of nodes) {
        if (!urls[node.figmaId]) continue
        const folder = join(assets, `${node.outlet}.imageset`)
        write(join(folder, `${node.outlet}@2x.png`), await download(urls[node.figmaId]))
        write(join(folder, 'Contents.json'), JSON.stringify({ images: [{ idiom: 'universal', filename: `${node.outlet}@2x.png`, scale: '2x' }], info: { author: 'UIKitForge', version: 1 } }))
      }
      const refs = await figmaImages(figma.fileKey, [figma.nodeId], '&scale=1&use_absolute_bounds=true')
      if (refs[figma.nodeId]) {
        write(join(OUT, 'references', `${fixture}.png`), await download(refs[figma.nodeId]))
        reference = true
      }
    } catch (error) {
      console.warn(`${fixture}: could not fetch Figma images (${error.message})`)
    }
  }
  targets.push(module)
  const { width, height } = compiled.previewRoot.frame
  tests.push({ fixture, module, width, height, reference })
}

write(join(OUT, 'Package.swift'), `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SnapshotHost",
    platforms: [.iOS(.v16)],
    products: [.library(name: "SnapshotHost", targets: [${targets.map(name => `"${name}"`).join(', ')}])],
    targets: [
${targets.map(name => `        .target(name: "${name}", resources: [.process("Assets.xcassets")]),`).join('\n')}
        .testTarget(name: "SnapshotTests", dependencies: [${targets.map(name => `"${name}"`).join(', ')}])
    ]
)
`)

write(join(OUT, 'Tests', 'SnapshotTests', 'SnapshotTests.swift'), `import UIKit
import XCTest
${targets.map(name => `@testable import ${name}`).join('\n')}

final class SnapshotTests: XCTestCase {
${tests.map(test => `    func test_${test.fixture}() throws {
        try Snapshot.run(${test.module}.GeneratedView(frame: .zero), name: "${test.fixture}", size: CGSize(width: ${test.width}, height: ${test.height}))
    }`).join('\n\n')}
}
`)

write(join(OUT, 'Tests', 'SnapshotTests', 'Snapshot.swift'), `import UIKit
import XCTest

// Render view ở scale 1 (cùng tỉ lệ ảnh Figma xuất ở scale 1) rồi so từng pixel với ảnh tham chiếu.
// Pixel "khớp" khi mọi kênh RGB lệch ≤ 16/255 — chữ khử răng cưa khác nhau giữa Figma và iOS nên không đòi khớp tuyệt đối.
enum Snapshot {
    static let tolerance = 16

    static func run(_ view: UIView, name: String, size: CGSize) throws {
        let environment = ProcessInfo.processInfo.environment
        let output = URL(fileURLWithPath: environment["SNAPSHOT_OUTPUT_DIR"] ?? NSTemporaryDirectory())
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        // layer.render không cần window/scene (logic test không có app host); blur của UIVisualEffectView sẽ ra màu phẳng.
        view.frame = CGRect(origin: .zero, size: size)
        view.setNeedsLayout()
        view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
            view.layer.render(in: context.cgContext)
        }
        try rendered.pngData()?.write(to: output.appendingPathComponent("\\(name).png"))

        let referencePath = (environment["SNAPSHOT_REFERENCE_DIR"] ?? "") + "/\\(name).png"
        guard let reference = UIImage(contentsOfFile: referencePath) else {
            try "{\\"name\\":\\"\\(name)\\",\\"reference\\":false}".write(
                to: output.appendingPathComponent("\\(name).json"), atomically: true, encoding: .utf8
            )
            return
        }
        let result = compare(rendered, reference, size: size)
        try result.diff.pngData()?.write(to: output.appendingPathComponent("\\(name)-diff.png"))
        let json = String(
            format: "{\\"name\\":\\"%@\\",\\"reference\\":true,\\"match\\":%.4f,\\"meanDelta\\":%.4f}",
            name, result.match, result.meanDelta
        )
        try json.write(to: output.appendingPathComponent("\\(name).json"), atomically: true, encoding: .utf8)
        print("SNAPSHOT \\(name): match \\(result.match * 100)% meanDelta \\(result.meanDelta)")
    }

    private static func pixels(_ image: UIImage, size: CGSize) -> [UInt8] {
        let width = Int(size.width)
        let height = Int(size.height)
        var data = [UInt8](repeating: 0, count: width * height * 4)
        data.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ), let cgImage = image.cgImage else { return }
            // Nền trắng: vùng trong suốt của hai ảnh so trên cùng một nền.
            context.setFillColor(UIColor.white.cgColor)
            context.fill(CGRect(origin: .zero, size: size))
            context.draw(cgImage, in: CGRect(origin: .zero, size: size))
        }
        return data
    }

    private static func compare(_ rendered: UIImage, _ reference: UIImage, size: CGSize) -> (match: Double, meanDelta: Double, diff: UIImage) {
        let lhs = pixels(rendered, size: size)
        let rhs = pixels(reference, size: size)
        let count = Int(size.width) * Int(size.height)
        var matched = 0
        var total = 0
        var diff = [UInt8](repeating: 0, count: count * 4)
        for index in 0..<count {
            let offset = index * 4
            let delta = (0..<3).map { abs(Int(lhs[offset + $0]) - Int(rhs[offset + $0])) }.max() ?? 0
            total += delta
            if delta <= tolerance {
                matched += 1
                // Pixel khớp: ảnh render mờ đi để vùng lệch (đỏ) nổi bật.
                for channel in 0..<3 { diff[offset + channel] = UInt8(155 + Int(lhs[offset + channel]) / 3) }
            } else {
                diff[offset] = 255
            }
            diff[offset + 3] = 255
        }
        let image = diff.withUnsafeMutableBytes { buffer -> UIImage in
            let context = CGContext(
                data: buffer.baseAddress, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                bytesPerRow: Int(size.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
            return context?.makeImage().map { UIImage(cgImage: $0) } ?? UIImage()
        }
        return (Double(matched) / Double(max(count, 1)), Double(total) / Double(max(count, 1)) / 255, image)
    }
}
`)

write(join(OUT, 'snapshots.json'), JSON.stringify(tests, null, 2))
console.log(`Prepared ${OUT}/ (${tests.length} snapshots, ${tests.filter(test => test.reference).length} with Figma reference)`)
