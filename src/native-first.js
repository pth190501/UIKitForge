// Native-first suggestions are advisory. Figma metadata does not encode runtime
// data sources or interactions, so never replace a visual layer by name alone.
const MAX_PLAN_REGIONS = 120

export function discoverNativeRegions(root) {
  const regions = []
  const walk = (node, parent = null) => {
    if (!node || node.visible === false || regions.length >= MAX_PLAN_REGIONS) return
    const name = String(node.name || '')
    const id = String(node.id || 'unknown')
    const lower = name.toLowerCase()
    const children = (node.children || []).filter(child => child.visible !== false)

    // These are recommendations to verify against the Figma prototype, not
    // an assumption about a live data source or navigation behaviour.
    let suggestion = null
    let reason = null
    if (/banner|carousel|slider|slideshow/.test(lower) && node.type !== 'TEXT') {
      suggestion = 'UICollectionView + UIPageControl'
      reason = 'Candidate paged carousel; derive page count from the configured items'
    } else if (/^(tab bar|tabbar|menu bar|bottom navigation)$/.test(lower)) {
      suggestion = 'UITabBarController or an existing custom tab bar'
      reason = 'Bottom navigation candidate; confirm prototype actions and appearance'
    } else if (/^(search|search bar|search field)$/.test(lower)) {
      suggestion = 'UISearchBar or UISearchTextField'
      reason = 'Search input candidate; connect to actual search state'
    } else if (/(feed|list services|list items|vertical list)/.test(lower) && children.length > 1) {
      suggestion = 'UICollectionView / UITableView'
      reason = 'Repeated content candidate; prefer cell reuse for changing data'
    } else if (/(grid|utilities|quick action)/.test(lower) && children.length > 1) {
      suggestion = 'UICollectionViewCompositionalLayout'
      reason = 'Grid candidate; native adaptive layout and reusable cells'
    } else if (/(indicator|page control)/.test(lower) && node.type !== 'TEXT') {
      suggestion = 'UIPageControl'
      reason = 'Page indicator candidate; synchronize with content item count'
    }

    if (suggestion && parent?.id !== node.id) regions.push({ nodeId: id, name, suggestion, reason })
    for (const child of children) walk(child, node)
  }
  walk(root)
  return regions
}

export function nativePlanMarkdown(root, regions = discoverNativeRegions(root)) {
  const height = Number(root?.absoluteBoundingBox?.height || 0)
  const lines = [
    '# UIKit native-first implementation plan',
    '',
    'This mapping is based on layer names and hierarchy, not verified runtime behaviour.',
    'Keep existing visual output intact until each replacement passes native screenshot checks.',
    '',
    `- Root node: ${codeSpan(root?.id || 'unknown')}`,
    `- Root dimensions: ${root?.absoluteBoundingBox?.width || '?'} × ${height || '?'} pt`,
    `- Native candidates: ${regions.length}`,
    '',
    '## Critical implementation rules',
    '',
    '- Use native UIKit controls when their behaviours and visual properties match the Figma design.',
    '- Use one primary vertical scroll container; prefer reusable collection cells for long feeds.',
    '- Keep banners/data-driven UI configurable; no hardcoded item count or current page.',
    '- Figma visuals and component variants are not evidence for API/business logic.',
    '- Use actual Xcode/UIKit screenshot comparisons to verify fidelity; browser pixel % is not a pass criterion.',
    '- Export and verify every original raster/vector asset at the correct geometry.',
    '',
    '## Candidate mapping',
    ''
  ]
  if (!regions.length) lines.push('No high-confidence native regions were detected from layer names.')
  for (const region of regions) {
    lines.push(`- **${markdownText(region.name)}** (${codeSpan(region.nodeId)}) → ${region.suggestion}. ${region.reason}.`)
  }
  if (regions.some(region => region.suggestion.includes('UIPageControl'))) {
    lines.push('', '## Banner component', '', 'A reusable `ForgeBannerCarouselView.swift` is provided in NativeComponents/ as an opt-in building block.')
    lines.push('Configure it from live Banner values; integrate only after verifying the original design and spacing.')
  }
  lines.push('', '## Acceptance', '', '- Native build and typecheck PASS', '- No Auto Layout warnings',
    '- 0/1/N dynamic item tests PASS', '- Screenshot comparison attached, with device/OS/scale recorded',
    '- All unverified differences documented (never claim 100% without a real render)', '')
  return lines.join('\n')
}

function markdownText(value) {
  // Tên và ID từ Figma không được phép tạo cú pháp mới trong tài liệu xuất.
  return String(value ?? '')
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, '\\$&')
}

function codeSpan(value) {
  const text = String(value ?? '').replace(/[\r\n]/g, ' ')
  const fence = '`'.repeat(Math.max(1, ...(text.match(/`+/g) || []).map(run => run.length + 1)))
  const padding = text.trim() && (/^\s|\s$/.test(text)) ? ' ' : ''
  return `${fence}${padding}${text}${padding}${fence}`
}

export function nativeSupportFiles(regions) {
  if (!regions.some(region => region.suggestion.includes('UIPageControl'))) return []
  return [{
    path: 'NativeComponents/ForgeBannerCarouselView.swift',
    name: 'ForgeBannerCarouselView.swift',
    language: 'swift',
    content: BANNER_CAROUSEL_SWIFT,
    kind: 'component',
    target: 'uikit'
  }]
}

const BANNER_CAROUSEL_SWIFT = `import UIKit

/// Optional native building block. Integrate after checking the target Figma frame.
/// Data and page count are always dynamic; no auto-scroll is assumed.
final class ForgeBannerCarouselView: UIView {
    struct Banner {
        let id: String
        let image: UIImage?
        let accessibilityLabel: String
    }

    var onBannerTap: ((Banner) -> Void)?
    var pageIndicatorTintColor: UIColor = .systemGray3 {
        didSet { pageControl.pageIndicatorTintColor = pageIndicatorTintColor }
    }
    var currentIndicatorTintColor: UIColor = .systemBlue {
        didSet { pageControl.currentPageIndicatorTintColor = currentIndicatorTintColor }
    }

    private let flowLayout: UICollectionViewFlowLayout = {
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.minimumInteritemSpacing = 0
        layout.minimumLineSpacing = 0
        return layout
    }()

    private lazy var collectionView: UICollectionView = {
        let view = UICollectionView(frame: .zero, collectionViewLayout: flowLayout)
        view.isPagingEnabled = true
        view.showsHorizontalScrollIndicator = false
        view.backgroundColor = .clear
        view.delegate = self
        view.dataSource = self
        view.register(BannerCell.self, forCellWithReuseIdentifier: BannerCell.reuseIdentifier)
        return view
    }()

    private let pageControl = UIPageControl()
    private var banners: [Banner] = []

    var currentPage: Int { pageControl.currentPage }
    var numberOfPages: Int { banners.count }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    func configure(banners newBanners: [Banner]) {
        let oldID = banners.indices.contains(currentPage) ? banners[currentPage].id : nil
        banners = newBanners
        let matchedIndex = oldID.flatMap { id in banners.firstIndex { $0.id == id } }
        let page = matchedIndex ?? 0
        pageControl.numberOfPages = banners.count
        pageControl.currentPage = min(page, max(0, banners.count - 1))
        pageControl.isHidden = banners.count <= 1
        pageControl.isUserInteractionEnabled = banners.count > 1
        collectionView.reloadData()
        collectionView.layoutIfNeeded()
        scrollToCurrentPage(animated: false)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = collectionView.bounds.size
        guard size.width > 0, size.height > 0, flowLayout.itemSize != size else { return }
        flowLayout.itemSize = size
        flowLayout.invalidateLayout()
        scrollToCurrentPage(animated: false)
    }

    private func setup() {
        clipsToBounds = true
        addSubview(collectionView)
        addSubview(pageControl)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        pageControl.translatesAutoresizingMaskIntoConstraints = false
        pageControl.pageIndicatorTintColor = pageIndicatorTintColor
        pageControl.currentPageIndicatorTintColor = currentIndicatorTintColor
        pageControl.addTarget(self, action: #selector(pageChanged), for: .valueChanged)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor),
            pageControl.centerXAnchor.constraint(equalTo: centerXAnchor),
            pageControl.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4)
        ])
    }

    @objc private func pageChanged() {
        scrollToCurrentPage(animated: true)
    }

    private func scrollToCurrentPage(animated: Bool) {
        guard !banners.isEmpty, collectionView.bounds.width > 0 else { return }
        let offset = CGPoint(x: CGFloat(currentPage) * collectionView.bounds.width, y: 0)
        collectionView.setContentOffset(offset, animated: animated)
    }

    private func updatePageFromScroll() {
        guard !banners.isEmpty, collectionView.bounds.width > 0 else { return }
        let raw = Int((collectionView.contentOffset.x / collectionView.bounds.width).rounded())
        pageControl.currentPage = min(max(0, raw), banners.count - 1)
    }
}

extension ForgeBannerCarouselView: UICollectionViewDataSource, UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        banners.count
    }

    func collectionView(
        _ collectionView: UICollectionView,
        cellForItemAt indexPath: IndexPath
    ) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: BannerCell.reuseIdentifier, for: indexPath
        )
        if let bannerCell = cell as? BannerCell {
            bannerCell.configure(banners[indexPath.item])
        }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard banners.indices.contains(indexPath.item) else { return }
        onBannerTap?(banners[indexPath.item])
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        updatePageFromScroll()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        updatePageFromScroll()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { updatePageFromScroll() }
    }
}

private final class BannerCell: UICollectionViewCell {
    static let reuseIdentifier = "ForgeBannerCell"

    private let imageView: UIImageView = {
        let view = UIImageView()
        view.clipsToBounds = true
        view.contentMode = .scaleAspectFill
        return view
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(imageView)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        contentView.addSubview(imageView)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)
        ])
    }

    func configure(_ banner: ForgeBannerCarouselView.Banner) {
        imageView.image = banner.image
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = banner.accessibilityLabel
    }
}
`;
