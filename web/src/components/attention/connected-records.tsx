"use client";

import Link from "next/link";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/dates";
import { useConfirmedLinks } from "@/lib/queries";
import type { ConfirmedLink } from "@/lib/types";

/**
 * What has already been connected — the other half of what needs you.
 *
 * A review surface that only ever counts down tells somebody what they have not decided and
 * never what they have. That is the half where a wrong decision lives: a bill attached to the
 * wrong payment looks exactly like a bill attached to the right one until you can see the list.
 *
 * Every row says **how** it happened, because a document a person accepted from an offer and
 * one that arrived already attached are two different acts, and a row that reported both the
 * same way would credit somebody with a decision they never made. When the ledger has nothing
 * but the bank's own narration to name a payment by, the row says so rather than presenting it
 * as a name somebody chose.
 */
export function ConnectedRecords({ limit = 8 }: { limit?: number }) {
  const links = useConfirmedLinks(limit);

  return (
    <Section
      title="Already connected"
      headingId="attention-connected"
      description="Records this ledger has tied to a payment. Open one to see everything about that event."
      actions={
        <Link
          href="/evidence?linkage=linked"
          className={buttonVariants({ variant: "link", size: "sm" })}
        >
          All connected records
        </Link>
      }
    >
      {links.isPending && (
        <LoadingStatus label="Looking up what is connected">
          <TableSkeleton columns={3} rows={2} />
        </LoadingStatus>
      )}
      {links.isError && <ErrorBlock error={links.error} onRetry={() => void links.refetch()} />}

      {links.isSuccess && links.data.total === 0 && (
        <EmptyBlock>
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-ink">Nothing has been connected yet.</p>
            <p className="max-w-prose text-meta text-ink-muted">
              A bill, receipt or payment message becomes connected once it is tied to the payment it
              describes — either because you agreed with a suggestion, or because you said which
              payment it was about. This is the list being empty, not a filter hiding something.
            </p>
            <Link href="/add" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Add bills and receipts
            </Link>
          </div>
        </EmptyBlock>
      )}

      {links.isSuccess && links.data.total > 0 && (
        <>
          <ul className="flex flex-col divide-y divide-rule border-y border-rule">
            {links.data.links.map((link) => (
              <ConnectedRow key={link.evidenceId} link={link} />
            ))}
          </ul>
          {links.data.truncated && (
            <p className="mt-3 text-meta text-ink-muted">
              The {links.data.links.length} most recent of {links.data.total} connected records.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function ConnectedRow({ link }: { link: ConfirmedLink }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-ink">
          {link.recordWords}
          {link.payment !== null && (
            <>
              {" · "}
              <Link
                href={`/connections/${link.payment.paymentId}`}
                className="text-accent underline underline-offset-2"
              >
                {link.payment.name}
              </Link>
            </>
          )}
        </p>
        <p className="mt-0.5 text-micro text-ink-faint">
          {howWords(link)}
          {/*
            The bank's words are not a name anybody chose, and saying which it is costs one
            clause. A screen that printed a narration as a merchant would be claiming somebody
            had established it.
          */}
          {link.payment?.nameSource === "narration" && " · named from your bank's own wording"}
          {link.noPaymentBecause !== undefined && ` · ${link.noPaymentBecause}`}
        </p>
        {link.why.length > 0 && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-micro text-ink-muted">
              Why these were taken to be the same thing
            </summary>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-micro text-ink-muted">
              {link.why.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <span className="flex shrink-0 items-baseline gap-3">
        <span className="text-micro text-ink-faint">
          {formatDate(link.payment?.occurredAt ?? link.capturedAt)}
        </span>
        {link.payment !== null && (
          <Money
            paise={link.payment.amount}
            tone={link.payment.direction === "credit" ? "credit" : "neutral"}
          />
        )}
      </span>
    </li>
  );
}

/**
 * Who decided this, in a sentence — never a blank byline that reads as "the system did it".
 *
 * `decidedBy` is a stored actor string (`user:dev`), which is a true and useful thing to keep
 * and the wrong thing to print on the surface a non-technical reader uses. It stays in the
 * audit trail, reachable from the event; what this line carries is *when*, which is the part a
 * person checking their own work is actually looking for.
 */
function howWords(link: ConfirmedLink): string {
  if (link.origin === "attached_when_added") return "You said which payment this was about";
  if (link.decidedAt === null) return "You agreed with a suggested match";
  return `You agreed with a suggested match on ${formatDate(link.decidedAt)}`;
}
