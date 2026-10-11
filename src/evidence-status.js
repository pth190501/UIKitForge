export function evidenceStatus(report) {
  if (!report) return 'NOT_RUN'
  if (report.status === 'SKIPPED') return 'SKIPPED'
  if (report.status === 'FAILED') return 'FAILED'
  return report.status === 'COMPILED' ? 'COMPILED_UNVERIFIED' : 'UNKNOWN'
}
