import type { SourceRailId, SourceRailItem } from '../uiPresentation.ts'

interface SourceRailProps {
  items: SourceRailItem[]
  onSelect: (source: SourceRailId) => void
}

const SOURCE_MARKS: Record<SourceRailId, string> = {
  phone: 'P',
  health: 'H+',
  home: '⌂',
  checkins: '✓',
}

export function SourceRail({ items, onSelect }: SourceRailProps) {
  return (
    <section className="source-rail" aria-labelledby="source-rail-heading">
      <div className="source-rail-heading">
        <p className="eyebrow" id="source-rail-heading">Your sources</p>
        <span>Choose what works for you</span>
      </div>
      <div className="source-rail-scroll">
        {items.map((item) => <button
          type="button"
          className={`source-rail-item ${item.tone}`}
          key={item.id}
          aria-label={`${item.label}: ${item.state}. Open setup and details.`}
          onClick={() => onSelect(item.id)}
        >
          <span className="source-mark" aria-hidden="true">{SOURCE_MARKS[item.id]}</span>
          <span className="source-rail-copy">
            <strong>{item.label}</strong>
            <span>{item.state}</span>
            <small>{item.detail}</small>
          </span>
        </button>)}
      </div>
    </section>
  )
}
