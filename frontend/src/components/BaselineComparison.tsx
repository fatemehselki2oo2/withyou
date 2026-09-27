import type { BaselineQualificationState } from '../types.ts'

export interface BaselineSignal {
  label: string
  current: string
  baseline: string
  delta: string
  state: BaselineQualificationState
}

export interface BaselineComparisonRow {
  metric: string
  description: string
  signals: BaselineSignal[]
}

export function BaselineComparison({ rows }: { rows: BaselineComparisonRow[] }) {
  return (
    <section className="baseline-section" id="baseline" aria-labelledby="baseline-heading">
      <div className="section-intro">
        <div><p className="eyebrow">Personal, not generic</p><h2 id="baseline-heading">Current vs your baseline</h2></div>
        <p>Compact summaries only. Phone motion and Health steps remain separate signals.</p>
      </div>
      <div className="baseline-list">
        {rows.map((row) => <article className="baseline-row" key={row.metric}>
          <div className="baseline-row-heading"><h3>{row.metric}</h3><p>{row.description}</p></div>
          <div className="baseline-signals">
            {row.signals.map((signal) => <div className="baseline-signal" key={signal.label}>
              <div className="baseline-signal-label"><strong>{signal.label}</strong><span className={`state-badge ${signal.state}`}>{signal.state}</span></div>
              <dl>
                <div><dt>Current</dt><dd>{signal.current}</dd></div>
                <div><dt>Personal baseline</dt><dd>{signal.baseline}</dd></div>
                <div><dt>Difference</dt><dd>{signal.delta}</dd></div>
              </dl>
            </div>)}
          </div>
        </article>)}
      </div>
    </section>
  )
}
