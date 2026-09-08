import { NoteList } from "@/components/annotations";
import type { AnalyticsCaveats } from "@/lib/types";

/**
 * What a total on this screen deliberately leaves out, said rather than implied.
 *
 * The API carries these with every aggregate, and rendering them is the whole reason they are
 * carried: a spend figure without them asserts more precision than the ledger has. The pending
 * refund list is the sharper of the two — those expenses have money back that no allocation
 * reflects yet, so the totals above are about to move.
 */
export function AnalyticsCaveatList({ caveats }: { caveats: AnalyticsCaveats }) {
  const pending = caveats.pendingRefundExpenseIds.length;
  return (
    <div className="flex flex-col gap-3">
      <NoteList
        items={
          pending === 0
            ? []
            : [
                {
                  title: `${pending} ${pending === 1 ? "expense has" : "expenses have"} a refund the allocation does not reflect yet`,
                  detail:
                    "These totals are exactly what the current allocations say. Distributing " +
                    "those refunds will move them.",
                },
              ]
        }
      />
      <p className="max-w-prose text-meta text-ink-muted">
        Never included: {caveats.excludes.join("; ")}.
      </p>
    </div>
  );
}
