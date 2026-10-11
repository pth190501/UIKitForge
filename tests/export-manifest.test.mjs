import assert from 'node:assert/strict'
import { auditExportPaths } from '../src/node-coverage.js'
assert.equal(auditExportPaths([]).ok, true)
console.log('Export manifest baseline passed')
