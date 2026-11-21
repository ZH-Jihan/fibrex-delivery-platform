/**
 * Small bar chart of one figure per day (phase 4 row 4.6a), drawn as inline SVG: no chart
 * library is used anywhere in the web app, so none is added.
 *
 * Conventions: colours come only from the theme tokens (so light and dark both work), the
 * bars start at zero, the largest value is printed at the top left, the first and last dates
 * under the axis, every bar carries a `<title>` (hover and screen readers) and the whole chart
 * is an image with a text label; the exact numbers are always in the table next to it. A day
 * with no figure (`value` null) is drawn as a short grey tick, never as a zero bar, because
 * "the platform did not report that day" is not the same as "no orders".
 *
 * Depends on: nothing. Used by: ./PersonPerformanceTab.tsx.
 */

export interface DayBar {
  date: string;
  value: number | null;
}

const BAR = 12;
const GAP = 4;
const HEIGHT = 96;
const TOP = 14;
const BOTTOM = 16;

export function DayBars({
  bars,
  label,
  noFigure,
  tone = 'primary',
}: {
  bars: readonly DayBar[];
  /** Accessible name, for example "Orders per day". */
  label: string;
  /** Hover text of a day without a figure. */
  noFigure: string;
  tone?: 'primary' | 'accent';
}) {
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0));
  const width = Math.max(1, bars.length) * (BAR + GAP);
  const plot = HEIGHT - TOP - BOTTOM;
  const first = bars[0]?.date;
  const last = bars[bars.length - 1]?.date;
  return (
    <figure className="day-bars">
      <figcaption>{label}</figcaption>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
        preserveAspectRatio="xMinYMid meet"
        className={`day-bars-svg day-bars-${tone}`}
      >
        <text x={0} y={9} className="day-bars-max">
          {max}
        </text>
        <line
          x1={0}
          x2={width}
          y1={HEIGHT - BOTTOM}
          y2={HEIGHT - BOTTOM}
          className="day-bars-axis"
        />
        {bars.map((bar, i) => {
          const x = i * (BAR + GAP) + GAP / 2;
          if (bar.value === null) {
            return (
              <rect
                key={bar.date}
                x={x}
                y={HEIGHT - BOTTOM - 2}
                width={BAR}
                height={2}
                className="day-bars-none"
              >
                <title>{`${bar.date}: ${noFigure}`}</title>
              </rect>
            );
          }
          const h = max === 0 ? 0 : (bar.value / max) * plot;
          return (
            <rect
              key={bar.date}
              x={x}
              y={HEIGHT - BOTTOM - h}
              width={BAR}
              height={Math.max(h, bar.value > 0 ? 1 : 0)}
              rx={2}
              className="day-bars-bar"
            >
              <title>{`${bar.date}: ${String(bar.value)}`}</title>
            </rect>
          );
        })}
        {first === undefined ? null : (
          <text x={0} y={HEIGHT - 3} className="day-bars-date">
            {first}
          </text>
        )}
        {last === undefined || last === first ? null : (
          <text x={width} y={HEIGHT - 3} textAnchor="end" className="day-bars-date">
            {last}
          </text>
        )}
      </svg>
    </figure>
  );
}
