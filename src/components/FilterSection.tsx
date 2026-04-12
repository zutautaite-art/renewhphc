import type { ReactNode } from 'react'

export type FilterSectionProps = {
  sectionId: string
  titleBold: string
  titleRest?: string
  children?: ReactNode
}

export function FilterSection({ sectionId, titleBold, titleRest, children }: FilterSectionProps) {
  return (
    <section className="filterSection" aria-labelledby={sectionId}>
      <div className="filterSectionHeader" id={sectionId}>
        <span className="filterTitleBold">{titleBold}</span>
        {titleRest ? <span className="filterTitleRest">{titleRest}</span> : null}
      </div>
      {children != null && children !== false ? (
        <div className="filterSectionBody">{children}</div>
      ) : null}
    </section>
  )
}
