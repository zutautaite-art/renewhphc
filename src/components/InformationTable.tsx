
import type { HouseholdRecord } from '../types/households'

export type SelectedSmallAreaPanel = {
  name: string
  code: string
  /** One row per active (toggled on) small-area metric from filter manifest. */
  activeMetricRows: Array<{ label: string; valueDisplay: string }>
}

export type InformationTableProps = {
  activeMetrics: Array<{ label: string; geography: 'small_area' | 'town'; loadedAreas: number; unit?: string }>
  households?: HouseholdRecord[]
  loadedFileName?: string | null
  warnings?: string[]
  importSummary?: { sheetName: string; rowsImported: number; detail: string }[]
  uploadError?: string | null
  /** Click a small area on the map to show name, code, and values for active filters. */
  selectedSmallArea?: SelectedSmallAreaPanel | null
}

export function InformationTable(props: InformationTableProps) {
  const {
    activeMetrics,
    households,
    loadedFileName,
    warnings,
    importSummary,
    uploadError,
    selectedSmallArea,
  } = props
  return (
    <div className="informationTableBlock">
      <div className="informationTableTitle">Information</div>
      <ul className="informationSummaryLines">
        <li><strong>Loaded file:</strong> {loadedFileName ?? 'None'}</li>
        <li><strong>Household points:</strong> {(households?.length ?? 0).toLocaleString()}</li>
        <li><strong>Active filters:</strong> {activeMetrics.length ? activeMetrics.map((m) => m.label).join(', ') : 'None selected'}</li>
        <li><strong>Metric geographies:</strong> {activeMetrics.length ? [...new Set(activeMetrics.map((m) => m.geography))].join(', ') : '—'}</li>
        <li><strong>Areas with values:</strong> {activeMetrics.length ? activeMetrics.map((m) => `${m.label}: ${m.loadedAreas.toLocaleString()}`).join(' · ') : '—'}</li>
      </ul>

      {selectedSmallArea ? (
        <>
          <div className="informationTableTitle" style={{ marginTop: 10 }}>Selected small area</div>
          <ul className="informationSummaryLines">
            <li><strong>Name:</strong> {selectedSmallArea.name || '—'}</li>
            <li><strong>Code:</strong> {selectedSmallArea.code || '—'}</li>
            <li><strong>Active metrics (this area)</strong></li>
          </ul>
          {selectedSmallArea.activeMetricRows.length ? (
            <ul className="informationSummaryLines" style={{ marginTop: 4, paddingLeft: '1.1rem' }}>
              {selectedSmallArea.activeMetricRows.map((r) => (
                <li key={r.label}>
                  <strong>{r.label}:</strong> {r.valueDisplay}
                </li>
              ))}
            </ul>
          ) : (
            <p className="informationTableEmpty" style={{ marginTop: 4 }}>No small-area filters are active.</p>
          )}
        </>
      ) : (
        <p className="informationTableEmpty" style={{ marginTop: 8 }}>Click a small area on the map to see its code and active metric values here.</p>
      )}

      {uploadError ? <p className="informationTableEmpty">{uploadError}</p> : null}
      {importSummary && importSummary.length ? (
        <>
          <div className="informationTableTitle" style={{ marginTop: 8 }}>Import summary</div>
          <ul className="informationSummaryLines">
            {importSummary.map((r) => <li key={r.sheetName}><strong>{r.sheetName}</strong>: {r.rowsImported} rows — {r.detail}</li>)}
          </ul>
        </>
      ) : null}
      {warnings && warnings.length ? (
        <>
          <div className="informationTableTitle" style={{ marginTop: 8 }}>Warnings</div>
          <ul className="informationSummaryLines">
            {warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </>
      ) : null}
    </div>
  )
}
