// ViewController/ViewModel/Router (target 'uikit', xem uikit-router.js) sinh path cố định dưới
// `${rootClass}/` — khớp sẵn với UIKit-XIB, nhưng cần dời vào `UIKit-Code/${rootClass}/` khi export
// UIKit-Code để cả zip gộp về đúng 1 folder gốc, tránh thiếu ViewController/ViewModel/Router khi ship
// đúng như README dặn ("UIKit-Code/ thay vì {rootClass}/").
export function rerootSharedMVVMFile(file, outputTarget) {
  if (file.target !== 'uikit' || outputTarget !== 'uikit-code') return file
  return { ...file, path: `UIKit-Code/${file.path}` }
}
