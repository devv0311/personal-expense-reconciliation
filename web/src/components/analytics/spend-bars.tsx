import { Money } from "@/components/money";

/**
 * A labelled row per figure, with a proportional rule behind it.
 *
 * The same device the account waterfall uses, and for the same reason: the bar is geometry —
 * a proportion of the largest magnitude in the set — and carries no figure of its own. Every
 * number rendered is one the API computed. This is deliberately not a charting library; the
 * product has none, and a ledger reads better as aligned figures than as a plot
 * (`Design.md`, "Icons", "Interaction and motion").
 */
export function SpendBars({
  rows,
}: {
  rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly paise: string;
    readonly meta?: string;
  }[];
}) {
  const scale = rows.reduce((largest, row) => {
    const value = BigInt(row.paise);
    const magnitude = value < 0n ? -value : value;
    return magnitude > largest ? magnitude : largest;
  }, 1n);

  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-rule py-2 last:border-b-0"
        >
          <span className="text-body text-ink">
            {row.label}
            {row.meta !== undefined && (
              <span className="block text-micro text-ink-faint">{row.meta}</span>
            )}
          </span>
          <Money paise={row.paise} />
          <span
            aria-hidden="true"
            className="col-span-2 mt-1 block h-1 rounded-sm bg-rule-strong"
            style={{ width: `${barPercent(row.paise, scale)}%` }}
          />
        </li>
      ))}
    </ul>
  );
}

/** Integer percent of the largest magnitude. Never rendered as a number. */
function barPercent(paise: string, scale: bigint): number {
  const value = BigInt(paise);
  const magnitude = value < 0n ? -value : value;
  if (scale === 0n) return 0;
  return Number((magnitude * 100n) / scale);
}
