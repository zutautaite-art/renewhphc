import type { ReactNode } from 'react'

export type InlineSwitchProps = {
  id: string
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}

export type InlineSwitchPropsExtended = InlineSwitchProps & {
  unavailable?: boolean
}

export function InlineSwitch({ id, on, onChange, disabled, unavailable }: InlineSwitchPropsExtended) {
  const off = disabled || unavailable
  return (
    <label className={`switchLabel switchLabelInlineRight${off ? ' switchLabelDisabled' : ''}`} htmlFor={id}>
      <span className={`switchTrackWrap${unavailable ? ' switchTrackWrapUnavailable' : ''}`}>
        <input
          id={id}
          type="checkbox"
          className="switchInput"
          checked={on}
          disabled={off}
          onChange={(e) => {
            if (!off) onChange(e.target.checked)
          }}
        />
        <span className="switchTrack" aria-hidden="true">
          <span className="switchThumb" />
        </span>
        {unavailable ? (
          <svg className="switchUnavailableDiagonal" viewBox="0 0 40 22" preserveAspectRatio="none" aria-hidden>
            <line x1="0" y1="22" x2="40" y2="0" stroke="#dc2626" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
      </span>
      <span className="switchText">{on ? 'On' : 'Off'}</span>
    </label>
  )
}

export type MeasureRowProps = {
  switchId: string
  dataOn: boolean
  onDataOnChange: (on: boolean) => void
  children: ReactNode
  dataAvailable?: boolean
}

export function MeasureRow({ switchId, dataOn, onDataOnChange, children, dataAvailable }: MeasureRowProps) {
  const unavailable = dataAvailable === false
  const effectiveOn = unavailable ? false : dataOn

  return (
    <div className="measureRow">
      <div className="measureRowBody">{children}</div>
      <InlineSwitch id={switchId} on={effectiveOn} unavailable={unavailable} onChange={onDataOnChange} />
    </div>
  )
}
