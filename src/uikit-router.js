export const ARCHITECTURES = ['mvvm-r', 'mvvm', 'mvc', 'viper']

export function normalizeArchitecture(value) {
  return ARCHITECTURES.includes(value) ? value : 'mvvm-r'
}

// File kiến trúc (VC/VM/Router) dùng chung cho cả hai biến thể UIKit (XIB và Code) vì đều expose cùng class `rootClass`.
// MVVM-R: VC + VM + Router · MVVM: VC + VM (VC tự tạo VM mặc định) · MVC: chỉ VC giữ view · VIPER: xem generateUIKitViperFiles.
export function generateUIKitMVVMFiles({ rootClass, architecture = 'mvvm-r' }) {
  const arch = normalizeArchitecture(architecture)
  const base = rootClass.replace(/View$/, '') || rootClass
  if (arch === 'viper') return generateUIKitViperFiles(base, rootClass)
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

export function viperNames(base) {
  return {
    viewController: `${base}ViewController`, presenter: `${base}Presenter`, interactor: `${base}Interactor`,
    router: `${base}Router`, entity: `${base}Entity`, contract: `${base}Contract`,
    viewProtocol: `${base}ViewProtocol`, presenterProtocol: `${base}PresenterProtocol`,
    interactorInput: `${base}InteractorInputProtocol`, interactorOutput: `${base}InteractorOutputProtocol`, routerProtocol: `${base}RouterProtocol`
  }
}

// VIPER: View (VC) → Presenter (strong) → Interactor/Router (strong); ngược lại đều weak (Presenter.view,
// Interactor.output, Router.viewController) để module không tự giữ nhau thành retain cycle.
function generateUIKitViperFiles(base, rootClass) {
  const n = viperNames(base)
  const file = (name, content) => swiftFile(`${rootClass}/${name}.swift`, content, 'main')
  return [
    file(n.contract, `import Foundation\n\nprotocol ${n.viewProtocol}: AnyObject {}\n\nprotocol ${n.presenterProtocol}: AnyObject {\n    func viewDidLoad()\n}\n\n${viperSharedProtocols(n)}`),
    // Conformance tách ra extension: vừa là style Swift phổ biến, vừa giữ dòng khai báo class ngắn (line_length) khi tên màn hình dài.
    file(n.viewController, `import UIKit\n\nfinal class ${n.viewController}: UIViewController {\n    var presenter: ${n.presenterProtocol}?\n    private let contentView = ${rootClass}(frame: .zero)\n\n    override func loadView() {\n        view = contentView\n    }\n\n    override func viewDidLoad() {\n        super.viewDidLoad()\n        presenter?.viewDidLoad()\n    }\n}\n\nextension ${n.viewController}: ${n.viewProtocol} {}\n`),
    file(n.presenter, `import Foundation\n\nfinal class ${n.presenter} {\n    weak var view: ${n.viewProtocol}?\n    private let interactor: ${n.interactorInput}\n    private let router: ${n.routerProtocol}\n\n    init(\n        view: ${n.viewProtocol},\n        interactor: ${n.interactorInput},\n        router: ${n.routerProtocol}\n    ) {\n        self.view = view\n        self.interactor = interactor\n        self.router = router\n    }\n}\n\nextension ${n.presenter}: ${n.presenterProtocol} {\n    func viewDidLoad() {}\n}\n\nextension ${n.presenter}: ${n.interactorOutput} {}\n`),
    file(n.interactor, viperInteractor(n)),
    file(n.router, `import UIKit\n\nfinal class ${n.router} {\n    weak var viewController: UIViewController?\n\n    static func createModule() -> UIViewController {\n        let viewController = ${n.viewController}()\n        let interactor = ${n.interactor}()\n        let router = ${n.router}()\n        let presenter = ${n.presenter}(\n            view: viewController,\n            interactor: interactor,\n            router: router\n        )\n        viewController.presenter = presenter\n        interactor.output = presenter\n        router.viewController = viewController\n        return viewController\n    }\n}\n\nextension ${n.router}: ${n.routerProtocol} {}\n`),
    file(n.entity, viperEntity(n))
  ]
}

// Protocol dùng chung UIKit/SwiftUI: Interactor input/output + Router (SwiftUI không cần View/Presenter protocol
// vì View là struct quan sát trực tiếp Presenter).
export function viperSharedProtocols(n) {
  return `protocol ${n.interactorInput}: AnyObject {}\n\nprotocol ${n.interactorOutput}: AnyObject {}\n\nprotocol ${n.routerProtocol}: AnyObject {}\n`
}

export function viperInteractor(n) {
  return `import Foundation\n\nfinal class ${n.interactor} {\n    weak var output: ${n.interactorOutput}?\n}\n\nextension ${n.interactor}: ${n.interactorInput} {}\n`
}

export function viperEntity(n) {
  return `import Foundation\n\nstruct ${n.entity} {}\n`
}
