"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConnectedRecords } from "@/components/attention/connected-records";
import { QuestionFocus } from "@/components/attention/question-focus";
import { questionHref } from "@/components/attention/question-card";
import { Money } from "@/components/money";
import { PageHeader, Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { useAttention } from "@/lib/queries";
import type { AttentionItem } from "@/lib/types";

/**
 * Only the things a person has to decide — one at a time, in the questions they are.
 *
 * Two earlier shapes are worth knowing, because this is the third and each fixed the last.
 *
 * Phase B put this route in front of the review queue and left the queue's own vocabulary
 * showing: *classification decision*, *possible duplicate*, *rejected classification*,
 * *unmatched evidence*. Every one of those names the mechanism that produced the item, so the
 * reader had to classify their own problem before the screen would help. That is fixed by
 * reading `/api/attention`, where the API has already turned each into the question it actually
 * is, with only the facts needed to answer it.
 *
 * Phase F fixed the vocabulary and kept the list — thirty-five questions rendered as thirty-five
 * cards, each with its own set of category buttons. On the real ledger that is a screen you
 * scroll, not a screen you answer: no question is more urgent than the one below it, and no
 * point in the page is ever finished. **So it is now a queue.** One question at a time, the
 * facts beside it, and a *Decide later* that writes nothing.
 *
 * Three things did not change:
 *
 *  - **Nothing here decides anything.** Every consequential act is a `DecisionDialog` that
 *    states what it will do (ADR-0049). There is no one-click approval on this screen.
 *  - **What a payment was for comes first.** Those questions can be answered from the card
 *    itself; a duplicate comparison or an unplaced document is different work and sits behind
 *    them in the queue rather than in front of them.
 *  - **Both halves of the decision are here.** Below the queue is what has already been
 *    connected, because a review surface that only ever counts down gives a person no way to
 *    check a decision they have already made — and a wrongly attached document looks exactly
 *    like a rightly attached one until they can see the list.
 *
 * `/review` is unchanged and still linked, for anybody who wants the unfiltered queue.
 */
export default function NeedsAttentionPage() {
  const attention = useAttention({ limit: 100 });
  /**
   * The questions set aside during this visit, by id.
   *
   * Deliberately client-only and deliberately not persisted: *Decide later* must write nothing,
   * and anything durable — a note, a snooze, a `deferred_until` — would be a decision recorded
   * by a button whose whole promise is that it records none. Reloading the page brings them all
   * back, which is the honest behaviour and is what the button's own wording says.
   */
  const [setAside, setSetAside] = useState<readonly string[]>([]);

  const items = useMemo(() => attention.data?.items ?? [], [attention.data]);

  /**
   * Purpose questions first, then everything else, then the ones set aside.
   *
   * A purpose question is one the API attached a reading to: it can be answered from the card
   * itself, in a tap. Everything else needs a comparison, a document, or somebody naming
   * people. Ordering by that rather than by the queue's own priority is what keeps a long run
   * of near-identical duplicate checks from standing in front of the question most people came
   * to answer. Within each band the API's order is preserved.
   */
  const queue = useMemo(() => {
    const active = items.filter((item) => !setAside.includes(item.id));
    return [
      ...active.filter((item) => item.suggestion !== null),
      ...active.filter((item) => item.suggestion === null),
    ];
  }, [items, setAside]);

  const current = queue[0] ?? null;
  const deferred = useMemo(
    () => items.filter((item) => setAside.includes(item.id)),
    [items, setAside],
  );

  const decideLater = useCallback(() => {
    if (current === null) return;
    setSetAside((ids) => (ids.includes(current.id) ? ids : [...ids, current.id]));
  }, [current]);

  /**
   * What is on screen — a question, or the end of the queue — and whether it replaced something
   * the reader was already looking at.
   *
   * `QuestionFocus` cannot work this out for itself: it is keyed by the question's id, so every
   * new question is a fresh mount and any internal "first render?" flag reads `true` there.
   * Arriving on the page must not move focus — that would pull the cursor off the skip link —
   * but answering a question or setting one aside must, or the content swaps silently under a
   * keyboard.
   *
   * Adjusted during render rather than in an effect, which is React's documented way to derive
   * state from changing props: React re-runs this component before committing, so `shown` is
   * already correct by the time anything is painted and no extra frame is rendered with the
   * wrong value. A ref would be simpler to write and wrong to read here — a value consulted
   * during render is state, whatever it is stored in.
   *
   * The end of the queue counts as a screen of its own. When the last question is answered or
   * set aside, the button the reader just pressed leaves with it, and without this the cursor
   * falls to the top of the document with nothing said; bringing set-aside questions back is
   * the same swap in the other direction. Arriving on an empty queue is still an arrival, and
   * moves nothing.
   */
  const [shown, setShown] = useState<{ key: ScreenKey | null; replaced: boolean }>({
    key: null,
    replaced: false,
  });
  const onScreen: ScreenKey | null = attention.isSuccess ? (current?.id ?? QUEUE_END) : null;
  if (onScreen !== null && onScreen !== shown.key) {
    setShown({ key: onScreen, replaced: shown.key !== null });
  }
  const focusOnMount = shown.key === onScreen && shown.replaced;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Needs attention"
        description="Things the system will not decide on its own, one at a time. Nothing here changes anything until you choose."
        actions={
          <Link href="/review" className={buttonVariants({ variant: "link", size: "sm" })}>
            The full review queue
          </Link>
        }
      />

      {attention.isPending && (
        <LoadingStatus label="Checking what is waiting">
          <TableSkeleton columns={2} rows={4} />
        </LoadingStatus>
      )}
      {attention.isError && (
        <ErrorBlock error={attention.error} onRetry={() => void attention.refetch()} />
      )}

      {attention.isSuccess && attention.data.total === 0 && (
        <NothingWaiting focusOnMount={focusOnMount} />
      )}

      {attention.isSuccess && current !== null && (
        <QuestionFocus
          // Keyed so React remounts on a question change rather than reconciling one
          // question's open inspector and half-typed reason into the next one's.
          key={current.id}
          item={current}
          position={1}
          remaining={queue.length}
          setAsideCount={deferred.length}
          focusOnMount={focusOnMount}
          onDecideLater={decideLater}
        />
      )}

      {/* Every question answered, but some were set aside — say which, and offer them back. */}
      {attention.isSuccess && current === null && deferred.length > 0 && (
        <EmptyBlock>
          <div className="flex flex-col items-start gap-3">
            <QueueEndLead focusOnMount={focusOnMount}>
              That is everything except the ones you set aside.
            </QueueEndLead>
            <p className="max-w-prose text-body text-ink-muted">
              {deferred.length === 1 ? "One question is" : `${deferred.length} questions are`}{" "}
              waiting where you left {deferred.length === 1 ? "it" : "them"}. Nothing was recorded
              about {deferred.length === 1 ? "it" : "them"}.
            </p>
            <Button onClick={() => setSetAside([])}>
              {deferred.length === 1 ? "Bring it back" : "Bring them back"}
            </Button>
          </div>
        </EmptyBlock>
      )}

      {attention.isSuccess &&
        attention.data.total > 0 &&
        current === null &&
        deferred.length === 0 && <NothingWaiting answered focusOnMount={focusOnMount} />}

      {/* What is still in the queue behind the one on screen, so the count is never a mystery. */}
      {attention.isSuccess && queue.length > 1 && <UpNext items={queue.slice(1)} />}

      {attention.isSuccess && attention.data.truncated && (
        <p className="text-meta text-ink-muted">
          Showing the {attention.data.items.length} most important of {attention.data.total}.
          Answering these will bring the rest up.
        </p>
      )}

      {attention.isSuccess && <ConnectedRecords />}
    </div>
  );
}

/** What `shown` tracks: a question's id, or the end of the queue — which no id can equal. */
const QUEUE_END = Symbol("queue-end");
type ScreenKey = string | typeof QUEUE_END;

/**
 * The first line of an end state, and where focus lands when that state replaced a question.
 *
 * The same rule as the question heading in `QuestionFocus`, for the same reason, and like it
 * the caller decides: only this page knows whether the block replaced a question or is what
 * the reader arrived at.
 */
function QueueEndLead({ focusOnMount, children }: { focusOnMount: boolean; children: ReactNode }) {
  const lead = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusOnMount) lead.current?.focus();
    // Mount only, as in `QuestionFocus`: `focusOnMount` describes how this block came to exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <p ref={lead} tabIndex={-1} className="text-emphasis font-serif text-ink">
      {children}
    </p>
  );
}

function NothingWaiting({
  answered = false,
  focusOnMount,
}: {
  answered?: boolean;
  focusOnMount: boolean;
}) {
  return (
    <EmptyBlock>
      <div className="flex flex-col items-start gap-3">
        <QueueEndLead focusOnMount={focusOnMount}>
          {answered ? "That is all of them." : "Nothing is waiting on you."}
        </QueueEndLead>
        <p className="max-w-prose text-body text-ink-muted">
          Every record on file is either connected to another or accounted for. This is the list
          being empty, not a filter hiding something. New records may raise new questions.
        </p>
        <Link href="/add" className={buttonVariants({ variant: "outline" })}>
          Add records
        </Link>
      </div>
    </EmptyBlock>
  );
}

/**
 * The rest of the queue, readable but not answerable.
 *
 * Deliberately not interactive beyond a link to the event: putting the choice buttons back on
 * every row would restore the list this screen replaced. A person can see what is coming and
 * how much of it there is, which is what a queue owes its reader.
 */
function UpNext({ items }: { items: readonly AttentionItem[] }) {
  return (
    <Section
      title="Still to come"
      headingId="attention-up-next"
      description={`${items.length} more after this one.`}
    >
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {items.map((item) => {
          const href = questionHref(item);
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
            >
              <span className="min-w-0 flex-1 text-body text-ink">
                {href === null ? (
                  item.question
                ) : (
                  <Link href={href} className="hover:underline">
                    {item.question}
                  </Link>
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                {item.amount.known && item.amount.value !== null ? (
                  <Money paise={item.amount.value} />
                ) : (
                  <span className="text-meta text-ink-faint italic">Amount not known</span>
                )}
                <span className="text-micro text-ink-faint">{formatDate(item.occurredAt)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
