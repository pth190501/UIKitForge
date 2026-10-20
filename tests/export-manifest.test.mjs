import assert from 'node:assert/strict'
import { auditExportPaths } from '../src/node-coverage.js'
const example = [{ path: 'A.swift', target: 'uikit' }, { path: 'A.swift', target: 'uikit-xib' }]
assert.equal(auditExportPaths(example).collisions.length, 1)
console.log('Export manifest baseline passed')
