// Config tĩnh đi kèm mọi export để generated code lint sạch ngay trong dự án đích.
const SWIFTLINT_YML = `excluded:\n  - Pods\n  - .build\n\nline_length:\n  warning: 150\n  error: 200\n\nidentifier_name:\n  min_length: 3\n`
const SWIFTFORMAT = `--indent 4\n--swiftversion 5.9\n--self remove\n`

export const LINT_CONFIG_FILES = [
  { path: '.swiftlint.yml', name: '.swiftlint.yml', language: 'yaml', content: SWIFTLINT_YML, kind: 'config' },
  { path: '.swiftformat', name: '.swiftformat', language: 'text', content: SWIFTFORMAT, kind: 'config' }
]
