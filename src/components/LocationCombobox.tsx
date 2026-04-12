import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type ComboOption = {
  value: string
  label: string
}

export type LocationComboboxProps = {
  id?: string
  label: string
  placeholder: string
  options: ComboOption[]
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  loading?: boolean
  loadingHint?: string
  /** If true, field stays usable when `options` is empty (e.g. filtered town list). */
  allowEmptyOptions?: boolean
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

const LIST_MAX = 500

export function LocationCombobox({
  id: idProp,
  label,
  placeholder,
  options,
  value,
  onChange,
  disabled,
  loading,
  loadingHint = 'Loading…',
  allowEmptyOptions,
}: LocationComboboxProps) {
  const reactId = useId()
  const baseId = idProp ?? `loc-${reactId}`
  const listId = `${baseId}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)

  const selectedLabel = useMemo(() => {
    const o = options.find((x) => x.value === value)
    return o?.label ?? ''
  }, [options, value])

  useEffect(() => {
    setDraft(selectedLabel)
  }, [selectedLabel])

  const filtered = useMemo(() => {
    const q = norm(draft)
    if (!q) return options
    return options.filter(
      (o) => norm(o.label).includes(q) || norm(o.value).includes(q),
    )
  }, [options, draft])

  const listSlice = useMemo(() => filtered.slice(0, LIST_MAX), [filtered])

  useEffect(() => {
    setHighlightIdx(0)
  }, [draft])

  useEffect(() => {
    setHighlightIdx((i) => {
      if (listSlice.length === 0) return 0
      return Math.min(i, listSlice.length - 1)
    })
  }, [listSlice.length])

  useEffect(() => {
    if (!open || listSlice.length === 0) return
    const el = optionRefs.current.get(highlightIdx)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [highlightIdx, open, listSlice.length])

  const effectiveDisabled =
    disabled || loading || (!allowEmptyOptions && options.length === 0)

  function commit(nextValue: string, nextLabel: string) {
    onChange(nextValue)
    setDraft(nextLabel)
    setOpen(false)
    setHighlightIdx(0)
  }

  function clear() {
    onChange('')
    setDraft('')
    setOpen(false)
    setHighlightIdx(0)
  }

  return (
    <div className="locationCombobox">
      <label className="locationComboboxLabel" htmlFor={baseId}>
        <span className="fieldLabelBold">{label}</span>
      </label>
      <div className="locationComboboxWrap">
        <input
          ref={inputRef}
          id={baseId}
          type="text"
          className="locationComboboxInput"
          placeholder={loading ? loadingHint : placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={effectiveDisabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && listSlice.length > 0 ? `${baseId}-opt-${highlightIdx}` : undefined
          }
          aria-autocomplete="list"
          value={draft}
          onChange={(e) => {
            const v = e.target.value
            setDraft(v)
            setOpen(true)
            if (v === '') onChange('')
          }}
          onFocus={() => {
            if (!effectiveDisabled) setOpen(true)
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setOpen(false)
              if (value) {
                if (draft !== selectedLabel) setDraft(selectedLabel)
              } else if (draft && !options.some((o) => o.label === draft)) {
                setDraft('')
              }
            }, 180)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false)
              inputRef.current?.blur()
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (!effectiveDisabled && listSlice.length > 0) {
                setOpen(true)
                setHighlightIdx((i) => Math.min(i + 1, listSlice.length - 1))
              }
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              if (!effectiveDisabled && listSlice.length > 0) {
                setOpen(true)
                setHighlightIdx((i) => Math.max(i - 1, 0))
              }
              return
            }
            if (e.key === 'Enter') {
              if (listSlice.length === 0) return
              e.preventDefault()
              const o = listSlice[Math.min(highlightIdx, listSlice.length - 1)]!
              commit(o.value, o.label)
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="locationComboboxClear"
            aria-label={`Clear ${label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            ×
          </button>
        ) : null}
      </div>
      {open && !effectiveDisabled && listSlice.length > 0 ? (
        <ul
          id={listId}
          className="locationComboboxList"
          role="listbox"
          aria-label={`${label} suggestions`}
        >
          {listSlice.map((opt, idx) => (
            <li key={opt.value} role="presentation">
              <button
                id={`${baseId}-opt-${idx}`}
                type="button"
                className={
                  idx === highlightIdx
                    ? 'locationComboboxOption locationComboboxOptionActive'
                    : 'locationComboboxOption'
                }
                role="option"
                aria-selected={opt.value === value}
                ref={(el) => {
                  if (el) optionRefs.current.set(idx, el)
                  else optionRefs.current.delete(idx)
                }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => commit(opt.value, opt.label)}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
