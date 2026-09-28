export const ARCHITECTURES = ['mvvm-r', 'mvvm', 'mvc']

export function normalizeArchitecture(value) {
  return ARCHITECTURES.includes(value) ? value : 'mvvm-r'
}

// File kiến trúc (VC/VM/Router) dùng chung cho cả hai biến thể UIKit (XIB và Code) vì đều expose cùng class `rootClass`.
// MVVM-R: VC + VM + Router · MVVM: VC + VM (VC tự tạo VM mặc định) · MVC: chỉ VC giữ view.
export function generateUIKitMVVMFiles({ rootClass, architecture = 'mvvm-r' }) {
  const arch = normalizeArchitecture(architecture)
  const base = rootClass.replace(/View$/, '') || rootClass
  const names = { viewController: `${base}ViewController`, viewModel: `${base}ViewModel`, router: `${base}Router` }
  const files = [swiftFile(`${rootClass}/${names.viewController}.swift`, generateViewController(names, rootClass, arch), 'main')]
  if (arch !== 'mvc') files.push(swiftFile(`${rootClass}/${names.viewModel}.swift`, generateViewModel(names, arch), 'main'))
  if (arch === 'mvvm-r') files.push(swiftFile(`${rootClass}/${names.router}.swift`, generateRouter(names), 'main'))
  return files
}

function swiftFile(path, content, kind) {
  return { path, name: path.split('/').pop(), language: 'swift', content, kind, target: 'uikit' }
}

function generateViewController(names, rootClass, arch) {
  const loadView = `    override func loadView() {\n        view = contentView\n    }\n`
  if (arch === 'mvc') {
    return `import UIKit\n\nfinal class ${names.viewController}: UIViewController {\n    private let contentView = ${rootClass}(frame: .zero)\n\n${loadView}}\n`
  }
  // MVVM không có Router tạo sẵn VM, nên cho default để VC vẫn khởi tạo được một mình.
  const initArgs = arch === 'mvvm' ? `viewModel: ${names.viewModel} = ${names.viewModel}()` : `viewModel: ${names.viewModel}`
  return `import UIKit\n\nfinal class ${names.viewController}: UIViewController {\n    private let viewModel: ${names.viewModel}\n    private let contentView = ${rootClass}(frame: .zero)\n\n    init(${initArgs}) {\n        self.viewModel = viewModel\n        super.init(nibName: nil, bundle: nil)\n    }\n\n    @available(*, unavailable)\n    required init?(coder: NSCoder) {\n        fatalError("init(coder:) has not been implemented")\n    }\n\n${loadView}}\n`
}

function generateViewModel(names, arch) {
  if (arch === 'mvvm') return `import Foundation\n\nfinal class ${names.viewModel} {}\n`
  return `import Foundation\n\nfinal class ${names.viewModel} {\n    private let router: ${names.router}\n\n    init(router: ${names.router}) {\n        self.router = router\n    }\n}\n`
}

function generateRouter(names) {
  return `import UIKit\n\nfinal class ${names.router} {\n    weak var viewController: UIViewController?\n\n    static func makeViewController() -> UIViewController {\n        let router = ${names.router}()\n        let viewModel = ${names.viewModel}(router: router)\n        let viewController = ${names.viewController}(viewModel: viewModel)\n        router.viewController = viewController\n        return viewController\n    }\n}\n`
}
