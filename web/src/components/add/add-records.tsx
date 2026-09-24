"use client";

import Link from "next/link";
import { useState } from "react";
import { EvidenceIntake } from "@/components/evidence/evidence-intake";
import { ImportStatementForm } from "@/components/payments/import-statement";
import { ManualPaymentForm } from "@/components/payments/manual-payment-form";
import { Section } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One guided way in, for every kind of record a person actually holds.
 *
 * What this replaced was a page of four links, each one leaving for a screen named after the
 * mechanism that ingests it: **Import a statement** on the payment workspace, the **Evidence**
 * library with its three storage-shaped buttons, the manual form behind a query string on
 * `/payments`. Somebody holding a restaurant bill and a screenshot of the UPI payment had to
 * know which of those two things this system calls "evidence" and which it calls a "movement"
 * before either could be put in — and then had to find their way back.
 *
 * Here they say what they are holding, in their own words, and the form for it opens in place.
 * **The forms themselves are the existing ones, unchanged**: each is still a button that opens
 * a `DecisionDialog` stating exactly what it will write before it writes it (ADR-0049). This is
 * an information architecture, not a new write path — there is no way to add a record here that
 * did not exist before, and no way to add one without reading what it does.
 *
 * The "what happens next" panel below is the other half of the fix. Adding a statement used to
 * be silently insufficient: the rows sat unread until somebody found two buttons on another
 * screen called **Run normalization** and **Run classification**. Now the next step is offered
 * where the person already is, in the words of the thing it achieves.
 */
interface RecordKind {
  readonly id: string;
  /** What the person calls the thing in their hand. */
  readonly title: string;
  readonly summary: string;
  /** What adding it does, and — just as important — what it does not do. */
  readonly whatHappens: readonly string[];
  readonly form: React.ReactNode;
}

const KINDS: readonly RecordKind[] = [
  {
    id: "statement",
    title: "A bank or card statement",
    summary: "A PDF, CSV or spreadsheet, exactly as the bank sent it.",
    whatHappens: [
      "Every payment listed on it is read in at once, with its date, amount and the bank's own wording kept exactly as written.",
      "If any line cannot be read, nothing at all is added — you will never end up with half a statement on record.",
      "Adding the same file twice is recognised, not doubled.",
      "Nothing on it counts as spending yet. A statement says money moved; it does not say what for.",
    ],
    form: <ImportStatementForm triggerLabel="Choose a statement file" />,
  },
  {
    id: "bill",
    title: "A bill or receipt",
    summary: "What you were actually charged for, item by item where it lists them.",
    whatHappens: [
      "The document is stored on this machine as it is, and never altered.",
      "It is what turns a payment into something explainable: the line on your statement becomes a purchase with a reason.",
      "It is not attached to a payment yet. The system will suggest which payment it belongs to, and ask you before connecting it.",
    ],
    form: (
      <EvidenceIntake
        only={["file"]}
        labels={{ file: "Choose a bill or receipt" }}
        defaultType="receipt_image"
      />
    ),
  },
  {
    id: "screenshot",
    title: "A payment screenshot or message",
    summary: "A UPI confirmation, a bank SMS, an order confirmation.",
    whatHappens: [
      "Most useful when a statement line says nothing about who you paid — these usually name them.",
      "A pasted message is kept word for word, and what can be read off it is recorded beside it, never over it.",
      "As with a bill, nothing is connected to a payment until you agree it belongs there.",
    ],
    form: (
      <EvidenceIntake
        only={["file", "notification"]}
        labels={{ file: "Upload a screenshot", notification: "Paste the message" }}
        defaultType="screenshot"
      />
    ),
  },
  {
    id: "manual",
    title: "A payment nobody will send you a statement for",
    summary: "Cash you handed over, or anything an export will never show.",
    whatHappens: [
      "You say what moved, which way, and when. It is recorded as your own entry, so a later reader can always tell it from an imported line.",
      "Like every other record, it arrives unexplained — saying it happened is not saying what it was for.",
    ],
    form: <ManualPaymentForm triggerLabel="Type in a payment" />,
  },
  {
    id: "note",
    title: "Something you want to write down",
    summary: "An explanation, or a note that somebody says they have paid you back.",
    whatHappens: [
      "Your own account of something, stored as a record in its own right.",
      "A note that somebody says a debt is settled is exactly that — a note. It moves no money and clears no balance; recording the repayment itself is a separate step against a real payment.",
    ],
    form: <EvidenceIntake only={["note"]} labels={{ note: "Write it down" }} />,
  },
];

export function AddRecords() {
  // Nothing is chosen on arrival on purpose: the first thing the page asks is what you have,
  // and pre-opening one of the five would answer that question on the reader's behalf.
  const [chosen, setChosen] = useState<string | null>(null);
  const kind = KINDS.find((candidate) => candidate.id === chosen) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="What have you got?"
        headingId="add-kind"
        description="Pick one. You can come back and add the rest afterwards — they do not have to arrive together."
      >
        <ul className="grid gap-3 sm:grid-cols-2" role="list">
          {KINDS.map((candidate) => {
            const active = candidate.id === chosen;
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  aria-controls={active ? "add-form" : undefined}
                  onClick={() => setChosen(active ? null : candidate.id)}
                  className={cn(
                    "flex h-full w-full flex-col gap-1 rounded-sm border p-4 text-left transition-colors",
                    active
                      ? "border-accent bg-panel"
                      : "border-rule hover:border-rule-strong hover:bg-panel",
                  )}
                >
                  <span className="text-emphasis font-medium text-ink">{candidate.title}</span>
                  <span className="text-meta text-ink-muted">{candidate.summary}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {kind !== null && (
        <section
          id="add-form"
          aria-labelledby="add-form-heading"
          // `items-start` so a form's own trigger keeps its size: a stretched primary button
          // across the whole panel shouts at a screen whose whole point is to stay quiet.
          className="flex flex-col items-start gap-4 rounded-sm border border-rule p-5"
        >
          <div>
            <h2 id="add-form-heading" className="text-emphasis font-medium text-ink">
              {kind.title}
            </h2>
            <p className="mt-1 text-meta text-ink-muted">What adding this does:</p>
            <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-4 text-meta text-ink-muted">
              {kind.whatHappens.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          {kind.form}
        </section>
      )}

      <Section
        title="What happens after you add something"
        headingId="add-next"
        description="Three steps, and you are asked before anything is decided about your money."
      >
        <ol className="flex max-w-prose flex-col gap-3">
          <Step n={1} title="The records are read">
            Dates, amounts and which way the money went are read off exactly as written. Payments
            between your own accounts are paired up, so paying a credit-card bill is never counted
            as spending. This happens the moment you add them — there is nothing to press.
          </Step>
          <Step n={2} title="Records about the same thing are put together">
            A statement line, the bill for it and the screenshot of it are one purchase. Where it is
            sure, it connects them; where it is not, it asks.
          </Step>
          <Step n={3} title="You answer what is left">
            Anything uncertain becomes a short question on{" "}
            <Link href="/needs-attention" className="underline underline-offset-2">
              Needs attention
            </Link>
            . Nothing is counted, shared or owed until you say so.
          </Step>
        </ol>

        <p className="mt-5 max-w-prose text-meta text-ink-muted">
          Everything you add stays on this machine.{" "}
          <Link
            href="/records"
            className={cn(buttonVariants({ variant: "link", size: "sm" }), "px-0")}
          >
            The detailed screens
          </Link>{" "}
          show every original record exactly as it arrived.
        </p>
      </Section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-rule font-mono text-micro text-ink-muted"
      >
        {n}
      </span>
      <span className="min-w-0">
        <span className="block text-body text-ink">{title}</span>
        <span className="mt-0.5 block text-meta text-ink-muted">{children}</span>
      </span>
    </li>
  );
}
