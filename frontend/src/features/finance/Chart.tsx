import { useId } from 'react'
import type { Currency } from '../billing/money'
import { amount, coordinate } from './exact'
import { copy } from '../../i18n'
const t = (s: string) => copy(s, 'finance')
export function Chart({
  title,
  rows,
  currency,
}: {
  title: string
  rows: { label: string; value: string }[]
  currency: Currency
}) {
  const id = useId(),
    values = rows.map((r) => BigInt(r.value))
  const max = values.reduce(
    (m, n) => (m > (n < 0n ? -n : n) ? m : n < 0n ? -n : n),
    0n,
  )
  const width = Math.max(600, rows.length * 44),
    baseline = 125
  return (
    <figure className="finance-chart">
      <figcaption id={id} className="eyebrow mb-4">
        {t(title)} · {currency}
      </figcaption>
      {!rows.length ? (
        <p className="text-sm text-muted py-8">
          {t('No recorded activity in this period.')}
        </p>
      ) : (
        <>
          <div
            className="overflow-x-auto"
            role="region"
            aria-label={t(title)}
            tabIndex={0}
          >
            <svg
              viewBox={`0 0 ${width} 250`}
              width={width}
              aria-labelledby={id}
              role="img"
            >
              <desc>
                {t(
                  'Each bar represents exact recorded values. The table below provides the source amounts.',
                )}
              </desc>
              <line
                x1="0"
                y1={baseline}
                x2={width}
                y2={baseline}
                stroke="var(--chart-grid)"
              />
              <text x="8" y="18" fill="var(--text-muted)" fontSize="11">
                {amount(String(max), currency)}
              </text>
              {[25, 75, 175, 225].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2={width}
                  y2={y}
                  stroke="var(--chart-grid)"
                  strokeDasharray="2 5"
                />
              ))}
              {rows.map((r, i) => {
                const negative = BigInt(r.value) < 0n,
                  h = Math.abs(coordinate(r.value, max, 100))
                const cell = width / rows.length
                const x = i * cell + cell / 2
                const barWidth = Math.min(26, cell * 0.55)
                return (
                  <g key={r.label}>
                    <rect
                      x={x - barWidth / 2}
                      y={negative ? baseline : baseline - h}
                      width={barWidth}
                      height={Math.max(h, 1)}
                      fill={
                        negative
                          ? 'var(--chart-negative)'
                          : 'var(--chart-primary)'
                      }
                      tabIndex={0}
                      aria-label={`${r.label}: ${amount(r.value, currency)}`}
                    >
                      <title>
                        {r.label}: {amount(r.value, currency)}
                      </title>
                    </rect>
                    <text
                      x={x}
                      y="245"
                      textAnchor="middle"
                      fill="var(--text-muted)"
                      fontSize="10"
                    >
                      {r.label}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
          <details className="mt-3">
            <summary className="text-xs cursor-pointer">
              {t('Exact chart values')}
            </summary>
            <dl className="finance-chart-values">
              {rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{amount(r.value, currency)}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </figure>
  )
}
