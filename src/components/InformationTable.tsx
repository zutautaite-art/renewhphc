
import type { HouseholdRecord } from '../types/households'

export type InformationTableProps = {
  activeMetrics: Array<{ key: string; label: string; geography: string; loadedAreas: number; unit?: string }>
  households?: HouseholdRecord[]
  evCommercial?: HouseholdRecord[]
  loadedFileName?: string | null
  warnings?: string[]
  importSummary?: { sheetName: string; rowsImported: number; detail: string }[]
  uploadError?: string | null
}

export function InformationTable(props: InformationTableProps) {
  const {
    activeMetrics,
    households,
    evCommercial,
    loadedFileName,
    warnings,
    importSummary,
    uploadError,
  } = props

  return (
    <div className="informationTableBlock">
      {/* Always show summary at top */}
      <div className="informationTableTitle">Information</div>
      <ul className="informationSummaryLines">
        <li>
          <strong>Loaded file:</strong> {loadedFileName ?? 'None'}
        </li>
        {!loadedFileName ? (
          <li style={{ color: '#ef4444', fontSize: 11, marginTop: 4 }}>
            {'\u26A0'} Upload Excel file to show household dots and enable precise filter labels
          </li>
        ) : null}
        <li>
          <strong>Households:</strong> {households?.length ?? 0}
          {(households?.length ?? 0) === 0 ? (
            <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 6 }}>— upload file to show dots</span>
          ) : null}
        </li>
        <li>
          <strong>EV Commercial:</strong> {evCommercial?.length ?? 0}
          {(evCommercial?.length ?? 0) === 0 ? (
            <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 6 }}>— upload file to show dots</span>
          ) : null}
        </li>
        <li>
          <strong>Active filters:</strong> {activeMetrics.length ? activeMetrics.map((m) => m.label).join(', ') : 'None selected'}
        </li>
      </ul>

      {uploadError ? <p className="informationTableEmpty">{uploadError}</p> : null}

      {/* Import summary */}
      {importSummary && importSummary.length ? (
        <>
          <div className="informationTableTitle" style={{ marginTop: 8 }}>
            Import summary
          </div>
          <ul className="informationSummaryLines">
            {importSummary.map((r) => (
              <li key={r.sheetName}>
                <strong>{r.sheetName}</strong>: {r.rowsImported} rows — {r.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* Warnings */}
      {warnings && warnings.length ? (
        <>
          <div className="informationTableTitle" style={{ marginTop: 8 }}>
            Warnings
          </div>
          <ul className="informationSummaryLines">
            {warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}
