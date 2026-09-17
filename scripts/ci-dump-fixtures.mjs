// Xuất file UIKit/SwiftUI từ fixtures ra đĩa để CI macOS chạy swiftc/ibtool thật thay vì chỉ test JS.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen, layoutScreen } from '../tests/fixtures.mjs'

const OUT_DIR = 'ci-artifacts'
const FIXTURES = { layoutScreen, cardScreen }
const TARGETS = [13, 17]

rmSync(OUT_DIR, { recursive: true, force: true })

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

for (const [fixtureName, data] of Object.entries(FIXTURES)) {
  for (const deploymentTarget of TARGETS) {
    const dir = join(OUT_DIR, `${fixtureName}-ios${deploymentTarget}`)
    const compiled = compileUIKit(data, 'GeneratedView', { deploymentTarget })
    for (const file of compiled.files) {
      if (file.target === 'uikit-code') write(join(dir, 'uikit-code', file.path), file.content)
      else if (file.target === 'uikit-xib') write(join(dir, 'uikit-xib', file.path), file.content)
      else if (file.language === 'swift') {
        // Router/VM/VC dùng chung class rootClass với cả hai biến thể — nhân bản vào cả hai để typecheck riêng từng bộ.
        write(join(dir, 'uikit-xib', file.path), file.content)
        write(join(dir, 'uikit-code', file.path), file.content)
      }
    }
    for (const file of compiled.swiftUIFiles) write(join(dir, 'swiftui', file.path), file.content)
  }
}

console.log(`Dumped fixtures to ${OUT_DIR}/`)
