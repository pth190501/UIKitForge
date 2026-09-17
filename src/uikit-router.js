// Router/VM/VC dùng chung cho cả hai biến thể UIKit (XIB và Code) vì đều expose cùng class `rootClass`.
export function generateUIKitMVVMFiles({ rootClass }) {
  const base = rootClass.replace(/View$/, '') || rootClass
  const names = { viewController: `${base}ViewController`, viewModel: `${base}ViewModel`, router: `${base}Router` }
  return [
    swiftFile(`${rootClass}/${names.viewController}.swift`, generateViewController(names, rootClass), 'main'),
    swiftFile(`${rootClass}/${names.viewModel}.swift`, generateViewModel(names), 'main'),
    swiftFile(`${rootClass}/${names.router}.swift`, generateRouter(names), 'main')
  ]
}

function swiftFile(path, content, kind) {
  return { path, name: path.split('/').pop(), language: 'swift', content, kind, target: 'uikit' }
}

function generateViewController(names, rootClass) {
  return `import UIKit\n\nfinal class ${names.viewController}: UIViewController {\n    private let viewModel: ${names.viewModel}\n    private let contentView = ${rootClass}(frame: .zero)\n\n    init(viewModel: ${names.viewModel}) {\n        self.viewModel = viewModel\n        super.init(nibName: nil, bundle: nil)\n    }\n\n    @available(*, unavailable)\n    required init?(coder: NSCoder) {\n        fatalError("init(coder:) has not been implemented")\n    }\n\n    override func loadView() {\n        view = contentView\n    }\n}\n`
}

function generateViewModel(names) {
  return `import Foundation\n\nfinal class ${names.viewModel} {\n    private let router: ${names.router}\n\n    init(router: ${names.router}) {\n        self.router = router\n    }\n}\n`
}

function generateRouter(names) {
  return `import UIKit\n\nfinal class ${names.router} {\n    weak var viewController: UIViewController?\n\n    static func makeViewController() -> UIViewController {\n        let router = ${names.router}()\n        let viewModel = ${names.viewModel}(router: router)\n        let viewController = ${names.viewController}(viewModel: viewModel)\n        router.viewController = viewController\n        return viewController\n    }\n}\n`
}
