// Green CI jobs may have skipped optional Figma or reference-image checks.
export function evidenceStatus(report) {
  if (!report) return 'NOT_RUN'
  if (report.status === 'SKIPPED') return 'SKIPPED'
  if (report.status === 'FAILED') return 'FAILED'
  if (report.status !== 'COMPILED') return 'UNKNOWN'
  if (!(report.tree?.nodes > 0 && report.outputFiles > 0)) return 'INVALID'
  return 'COMPILED_UNVERIFIED'
}

export function snapshotEvidence(manifest, results = {}) {
  if (!Array.isArray(manifest) || !manifest.length) return 'NOT_RUN'
  const rendered = manifest.filter(item => results[item.fixture])
  if (rendered.length !== manifest.length) return 'INCOMPLETE'
  return rendered.some(item => results[item.fixture].reference === true)
    ? 'REFERENCE_AVAILABLE' : 'NO_FIGMA_REFERENCE'
}
