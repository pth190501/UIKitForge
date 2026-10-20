// Xuất file UIKit/SwiftUI từ fixtures ra đĩa để CI macOS chạy swiftc/ibtool thật thay vì chỉ test JS.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compileUIKit } from '../src/compiler.js'
import { ARCHITECTURES } from '../src/uikit-router.js'
import { LINT_CONFIG_FILES } from '../src/lint-config.js'
import { banGoiNgayScreen, cardScreen, feedSlotScreen, fidelityScreen, componentPropertiesScreen, layoutScreen, longScreen, textStylingScreen } from '../tests/fixtures.mjs'

const OUT_DIR = 'ci-artifacts'
const ANDROID_DIR = join(OUT_DIR, 'android-compose')
const ANDROID_NAMESPACE = 'com.uikitforge.ci'
const FIXTURES = { layoutScreen, cardScreen, feedSlotScreen, banGoiNgayScreen, fidelityScreen, textStylingScreen, longScreen, componentPropertiesScreen }
const ANDROID_FIXTURES = { layoutScreen, cardScreen, fidelityScreen, longScreen, componentPropertiesScreen }
const TARGETS = [13, 17]

rmSync(OUT_DIR, { recursive: true, force: true })

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

for (const [fixtureName, data] of Object.entries(FIXTURES)) {
  for (const architecture of ARCHITECTURES) {
  for (const deploymentTarget of TARGETS) {
    // Tên thư mục kết thúc bằng -ios13/-ios17 để glob trong ci.yml (ci-artifacts/*-ios13) vẫn bắt được mọi kiến trúc.
    const dir = join(OUT_DIR, `${fixtureName}-${architecture}-ios${deploymentTarget}`)
    const compiled = compileUIKit(data, 'GeneratedView', { deploymentTarget, architecture })
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
}

const androidPackagePath = `${ANDROID_NAMESPACE.replaceAll('.', '/')}/uikitforge/generated`
const androidSourcePrefix = `Android/src/main/java/${androidPackagePath}/`
const androidResources = new Set()
let androidSourceCount = 0
for (const [fixtureName, data] of Object.entries(ANDROID_FIXTURES)) {
  const rootClass = `${fixtureName[0].toUpperCase()}${fixtureName.slice(1)}View`
  const compiled = compileUIKit(data, rootClass, { androidNamespace: ANDROID_NAMESPACE })
  for (const file of compiled.androidFiles) {
    if (!file.path.startsWith(androidSourcePrefix)) throw new Error(`Unexpected Android output path: ${file.path}`)
    write(join(ANDROID_DIR, 'src/main/java', androidPackagePath, file.path.slice(androidSourcePrefix.length)), file.content)
    androidSourceCount += 1
    for (const [, name] of file.content.matchAll(/\bR\.drawable\.([a-z][a-z0-9_]*)/g)) androidResources.add(name)
  }
}
if (androidSourceCount === 0) throw new Error('No Android Compose fixture files were generated.')

const placeholderVector = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="1dp" android:height="1dp" android:viewportWidth="1" android:viewportHeight="1">
    <path android:fillColor="#FF000000" android:pathData="M0,0h1v1h-1z" />
</vector>
`
for (const name of androidResources) write(join(ANDROID_DIR, 'src/main/res/drawable', `${name}.xml`), placeholderVector)

// Lint bằng đúng .swiftlint.yml đi kèm export (tắt `todo`...) — CI phản ánh đúng trải nghiệm trong dự án đích.
for (const file of LINT_CONFIG_FILES) write(join(OUT_DIR, file.path), file.content)

console.log(`Dumped fixtures to ${OUT_DIR}/`)
