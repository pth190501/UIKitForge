import assert from 'node:assert/strict'
import { compileUIKit } from '../src/compiler.js'
import { cardScreen } from './fixtures.mjs'

const compileWith = architecture => compileUIKit(cardScreen, 'HomeView', { deploymentTarget: 17, architecture })
const pathsOf = files => files.map(file => file.path)
const contentOf = (files, path) => files.find(file => file.path === path)?.content

// Giá trị lạ → MVVM-R (mặc định cũ), không throw.
assert.equal(compileWith('something-else').architecture, 'mvvm-r')
assert.equal(compileWith(undefined).architecture, 'mvvm-r')

// MVVM-R: giữ nguyên bộ file cũ.
const mvvmr = compileWith('mvvm-r')
for (const path of ['HomeView/HomeViewController.swift', 'HomeView/HomeViewModel.swift', 'HomeView/HomeRouter.swift']) assert.ok(pathsOf(mvvmr.files).includes(path), path)
for (const path of ['SwiftUI/Home/HomeView.swift', 'SwiftUI/Home/HomeViewModel.swift', 'SwiftUI/Home/HomeRouter.swift']) assert.ok(pathsOf(mvvmr.swiftUIFiles).includes(path), path)

// MVVM: VC + VM, không Router; VM không phụ thuộc Router; VC tự tạo VM mặc định.
const mvvm = compileWith('mvvm')
assert.ok(!pathsOf(mvvm.files).some(path => path.endsWith('Router.swift')), 'MVVM must not emit a UIKit router')
assert.ok(!pathsOf(mvvm.swiftUIFiles).some(path => path.endsWith('Router.swift')), 'MVVM must not emit a SwiftUI router')
assert.match(contentOf(mvvm.files, 'HomeView/HomeViewController.swift'), /init\(viewModel: HomeViewModel = HomeViewModel\(\)\)/)
assert.doesNotMatch(contentOf(mvvm.files, 'HomeView/HomeViewModel.swift'), /Router/)
assert.doesNotMatch(contentOf(mvvm.swiftUIFiles, 'SwiftUI/Home/HomeViewModel.swift'), /Router/)
assert.match(contentOf(mvvm.swiftUIFiles, 'SwiftUI/Home/HomeView.swift'), /HomeView\(viewModel: HomeViewModel\(\)\)/)

// MVC: chỉ VC giữ view (UIKit) / chỉ View với text viết thẳng (SwiftUI).
const mvc = compileWith('mvc')
assert.ok(!pathsOf(mvc.files).some(path => /ViewModel|Router/.test(path)), 'MVC UIKit has no VM/Router')
assert.deepEqual(pathsOf(mvc.swiftUIFiles).filter(path => path.startsWith('SwiftUI/Home/')), ['SwiftUI/Home/HomeView.swift'])
assert.doesNotMatch(contentOf(mvc.files, 'HomeView/HomeViewController.swift'), /viewModel/i)
const mvcSwiftUI = contentOf(mvc.swiftUIFiles, 'SwiftUI/Home/HomeView.swift')
assert.doesNotMatch(mvcSwiftUI, /viewModel/, 'MVC SwiftUI view must not reference a view model')
assert.match(mvcSwiftUI, /HomeView\(\)/)

// VIPER: đủ 6 file mỗi nền tảng; chiều sở hữu không tạo retain cycle (ngược chiều đều weak).
const viper = compileWith('viper')
const viperFiles = ['Contract', 'ViewController', 'Presenter', 'Interactor', 'Router', 'Entity']
for (const part of viperFiles) assert.ok(pathsOf(viper.files).includes(`HomeView/Home${part}.swift`), `UIKit VIPER ${part}`)
for (const part of ['Contract', 'View', 'Presenter', 'Interactor', 'Router', 'Entity']) assert.ok(pathsOf(viper.swiftUIFiles).includes(`SwiftUI/Home/Home${part}.swift`), `SwiftUI VIPER ${part}`)
assert.ok(!pathsOf(viper.files).some(path => path.includes('ViewModel')), 'VIPER has no ViewModel')
assert.match(contentOf(viper.files, 'HomeView/HomePresenter.swift'), /weak var view: HomeViewProtocol\?/)
assert.match(contentOf(viper.files, 'HomeView/HomeInteractor.swift'), /weak var output: HomeInteractorOutputProtocol\?/)
assert.match(contentOf(viper.files, 'HomeView/HomeRouter.swift'), /weak var viewController: UIViewController\?/)
assert.match(contentOf(viper.files, 'HomeView/HomeViewController.swift'), /presenter\?\.viewDidLoad\(\)/)
assert.match(contentOf(viper.files, 'HomeView/HomeRouter.swift'), /interactor\.output = presenter/)
assert.match(contentOf(viper.swiftUIFiles, 'SwiftUI/Home/HomeRouter.swift'), /UIHostingController\(rootView: HomeView\(presenter: presenter\)\)/)
// UIKit-Code: file VIPER dùng chung cũng phải về UIKit-Code/ như các kiến trúc khác (xem export-layout).
assert.ok(viper.files.filter(file => file.target === 'uikit').length === 6)

// Không file nào tham chiếu tới type không được sinh ra (vd MVVM còn nhắc Router).
for (const [arch, compiled] of Object.entries({ 'mvvm-r': mvvmr, mvvm, mvc, viper })) {
  const all = [...compiled.files, ...compiled.swiftUIFiles].filter(file => file.language === 'swift')
  const declared = new Set(all.flatMap(file => [...file.content.matchAll(/(?:class|struct|protocol) (\w+)/g)].map(match => match[1])))
  for (const file of all) {
    for (const [, type] of file.content.matchAll(/\b(Home(?:ViewModel|Router|ViewController|Presenter|Interactor|Entity))\b/g)) {
      assert.ok(declared.has(type), `${arch}: ${file.path} references undeclared ${type}`)
    }
    const count = char => file.content.split(char).length - 1
    assert.equal(count('{'), count('}'), `${arch}: ${file.path} unbalanced braces`)
  }
}

// Mọi kiến trúc × fixture × iOS target: dòng ≤ 120 ký tự (trừ dòng đã tắt line_length) — CI chạy swiftlint --strict.
const { layoutScreen, feedSlotScreen, banGoiNgayScreen } = await import('./fixtures.mjs')
for (const architecture of ['mvvm-r', 'mvvm', 'mvc', 'viper']) {
  for (const data of [cardScreen, layoutScreen, feedSlotScreen, banGoiNgayScreen]) {
    for (const deploymentTarget of [13, 17]) {
    // Tên màn hình dài thực tế — VIPER sinh nhiều tên ghép (…InteractorOutputProtocol) dễ vượt 120 ký tự.
    for (const rootClass of ['GeneratedView', 'MaintenanceNotificationFeedView']) {
      const compiled = compileUIKit(data, rootClass, { deploymentTarget, architecture })
      for (const file of [...compiled.files, ...compiled.swiftUIFiles].filter(item => item.language === 'swift')) {
        const lines = file.content.split('\n')
        lines.forEach((line, index) => {
          if (lines[index - 1]?.trim() === '// swiftlint:disable:next line_length') return
          assert.ok(line.length <= 120, `${architecture} iOS ${deploymentTarget} ${file.path}:${index + 1} is ${line.length} chars`)
        })
      }
    }
    }
  }
}

console.log('✓ architecture choice (MVVM-R default, MVVM, MVC, VIPER) for UIKit + SwiftUI passed')
