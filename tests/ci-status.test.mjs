import assert from 'node:assert/strict'
import { evidenceStatus, snapshotEvidence } from '../src/evidence-status.js'
assert.equal(evidenceStatus(null), 'NOT_RUN')
assert.equal(evidenceStatus({status:'SKIPPED'}), 'SKIPPED')
assert.equal(evidenceStatus({status:'COMPILED',tree:{nodes:4},outputFiles:2}), 'COMPILED_UNVERIFIED')
assert.equal(snapshotEvidence([{fixture:'home'}],{home:{reference:false}}), 'NO_FIGMA_REFERENCE')
console.log('CI evidence classifications passed')
