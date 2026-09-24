"use client";

import { useState } from "react";
import { PreparedResult } from "@/components/analysis/prepared-result";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ErrorBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { useAnalyzeRecords } from "@/lib/queries";

/**
 * Records nobody has read yet — offered, and read only when somebody asks.
 *
 * **This used to run itself.** It was mounted on the front page and fired a ledger-wide
 * `POST /api/analysis` from an effect the moment the page rendered, whenever any record was
 * unread. The intent was good and came straight from
 * [ADR-0061](../../../../docs/decisions/0061-an-import-reads-what-it-just-wrote.md): an import
 * should read what it just wrote, so nobody has to find a button named after the machinery.
 *
 * That ADR is unchanged and still holds — but it is about **the import path**, where the run is
 * scoped to the batch the same request committed. Opening the front page is not that. A run
 * from here is unscoped: it walks the whole ledger, writes a proposal against every record it
 * can read one for, and does it because somebody looked at a screen. A person who opens this
 * product to check a balance has not asked for that, cannot see it coming, and — because it
 * happens in an effect — has no moment at which to decline.
 *
 * So the reading is offered here in a sentence, and it happens when the button is pressed.
 * Nothing else changed: the same `prepareRecords` call, the same single-flight behind it, the
 * same stage reporting, and the same guarantee that it **approves nothing** — every stage
 * records suggestions a person still has to agree with.
 *
 * The dialog is not ceremony. `DecisionDialog` is how this product states a consequence before
 * an act, and reading the whole ledger is an act: it is the one place a single press writes
 * against a hundred and forty records at once.
 */
export function PrepareRecords({
  waiting,
  onFinished,
}: {
  /** How many records have not been read. Zero means there is nothing to offer. */
  waiting: number;
  /**
   * Called once a run finishes, so a parent that renders this only while records are waiting
   * can keep the result on screen: the run reads the records, the count drops to zero, and an
   * unguarded parent would unmount this at the exact moment it has something to say.
   */
  onFinished?: () => void;
}) {
  const analyze = useAnalyzeRecords();
  const [confirming, setConfirming] = useState(false);

  if (analyze.data !== undefined) return <PreparedResult result={analyze.data} />;

  return (
    <div className="flex flex-col items-start gap-3">
      <div>
        <p className="text-emphasis font-serif font-medium text-ink">
          {waiting === 1
            ? "One record has not been read yet"
            : `${waiting} records have not been read yet`}
        </p>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">
          Until they are read they count towards nothing — not spending, not a balance, not a
          question. Reading them works out what each one looks like it was for and which ones belong
          together. <strong className="font-medium">It decides nothing on its own.</strong>
        </p>
      </div>

      {analyze.isError && (
        <div className="flex flex-col items-start gap-3">
          <ErrorBlock error={analyze.error} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              analyze.reset();
              setConfirming(true);
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {!analyze.isError && (
        <Button disabled={analyze.isPending} onClick={() => setConfirming(true)}>
          {analyze.isPending ? "Reading your records…" : "Read them now"}
        </Button>
      )}

      {analyze.isPending && (
        <p role="status" className="text-meta text-ink-muted">
          Reading your records…
        </p>
      )}

      <DecisionDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          analyze.reset();
        }}
        title="Read the records that have not been read"
        consequence={
          <>
            This goes through{" "}
            <strong>
              {waiting === 1 ? "the one record" : `all ${waiting} records`} nothing has read yet
            </strong>{" "}
            and, for each, works out what it looks like it was for and which other records it may
            belong with. Everything it finds is a <strong>suggestion</strong> waiting for you.{" "}
            Nothing is counted as spending, nothing is connected, and nobody owes anything until you
            say so. Your original records are not changed.
          </>
        }
        confirmLabel="Read them"
        pending={analyze.isPending}
        error={analyze.error}
        onConfirm={() => {
          analyze.mutate(
            { actor: "user" },
            {
              onSuccess: () => {
                setConfirming(false);
                onFinished?.();
              },
            },
          );
        }}
      />
    </div>
  );
}
