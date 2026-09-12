"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { ResponsiveTable } from "@/components/responsive-table";
import { ErrorBlock } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/dates";
import { confidenceLabel } from "@/lib/labels";
import { useAskCapabilities, useAskLedger } from "@/lib/queries";
import type { AskResult, LedgerAnswer } from "@/lib/types";

/**
 * Ask the ledger a question, and read an answer built entirely from its own reads (ADR-0057).
 *
 * Three things this screen is arranged to make impossible to miss:
 *
 * - **The interpretation comes first.** Every answer states how the question was read, because
 *   the worst failure available on this path is answering a different question correctly, and
 *   the reader is the only one who can catch it.
 * - **No figure here was computed in the browser, or by a model.** Each one arrives as exact
 *   paise from the service read the answer names, and this file formats it and nothing else
 *   (ADR-0048, rule 1).
 * - **No answer acts.** Where one implies something ought to be done, it links to the screen
 *   that owns the act — behind that screen's own dialog and its own recorded reason.
 */
export function AskPanel() {
  const [question, setQuestion] = useState("");
  const capabilities = useAskCapabilities();
  const ask = useAskLedger();

  const model = capabilities.data?.model;
  const unavailable = model !== undefined && !model.configured;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (question.trim().length === 0 || unavailable) return;
    ask.mutate(question.trim());
  }

  return (
    <div className="flex flex-col gap-8">
      {unavailable && (
        <Alert variant="attention">
          <AlertTitle>Asking is unavailable on this installation.</AlertTitle>
          <AlertDescription>
            <p>{model?.unavailableReason}</p>
            <p className="mt-2">
              Every figure a question would report is reachable from the screen that owns it —{" "}
              <Link href="/analytics" className="text-accent underline underline-offset-2">
                analytics
              </Link>
              ,{" "}
              <Link href="/balances" className="text-accent underline underline-offset-2">
                balances
              </Link>
              ,{" "}
              <Link href="/expenses" className="text-accent underline underline-offset-2">
                expenses
              </Link>{" "}
              and{" "}
              <Link href="/reconciliation" className="text-accent underline underline-offset-2">
                reconciliation
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        <Label htmlFor="question">Your question</Label>
        <Textarea
          id="question"
          value={question}
          maxLength={500}
          disabled={unavailable}
          placeholder="What did I actually spend last month?"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-micro text-ink-faint">
            This surface only reads. It cannot record, approve, settle or delete anything, and it
            never runs a query of its own — a question becomes one of the reads listed below.
          </p>
          <Button type="submit" disabled={unavailable || ask.isPending || question.trim() === ""}>
            {ask.isPending ? "Asking…" : "Ask"}
          </Button>
        </div>
      </form>

      {ask.isError && <ErrorBlock error={ask.error} />}
      {ask.isSuccess && <AnswerBlock result={ask.data} />}

      <Section
        title="What can be asked"
        headingId="ask-capabilities"
        description="A closed set. Each one names the authoritative read that produces every figure in its answer, so an answer is checkable against the screen that shows the same number."
      >
        {capabilities.isError && <ErrorBlock error={capabilities.error} />}
        {capabilities.isSuccess && (
          <ResponsiveTable
            caption="Questions this ledger can answer"
            minWidth="560px"
            rows={[...capabilities.data.queries]}
            rowKey={(entry) => entry.kind}
            columns={[
              {
                key: "example",
                header: "For example",
                render: (entry) => (
                  <button
                    type="button"
                    className="text-left text-accent underline underline-offset-2"
                    disabled={unavailable}
                    onClick={() => setQuestion(entry.example)}
                  >
                    {entry.example}
                  </button>
                ),
              },
              {
                key: "answers",
                header: "Answers",
                render: (entry) => <span className="text-ink-muted">{entry.answers}</span>,
              },
              {
                key: "source",
                header: "Figures come from",
                secondary: true,
                render: (entry) => (
                  <span className="font-mono text-micro text-ink-faint">{entry.source}</span>
                ),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

function AnswerBlock({ result }: { result: AskResult }) {
  const { answer } = result;
  const hero = answer.figures.find((figure) => figure.amount !== null);

  return (
    <div className="flex flex-col gap-6 border-t border-rule pt-6">
      <div>
        <p className="text-meta text-ink-muted">{answer.interpretation}</p>
        <p className="mt-2 max-w-prose text-emphasis text-ink">{answer.headline}</p>
      </div>

      {answer.answered && hero !== undefined && (
        <div>
          <Money paise={hero.amount ?? "0"} size="figure" />
          <p className="mt-1 text-meta text-ink-muted">{hero.label}</p>
        </div>
      )}

      {answer.figures.length > 0 && (
        <Facts>
          {answer.figures.map((figure) => (
            <Fact key={figure.label} label={figure.label} mono={figure.amount !== null}>
              {figure.amount !== null ? (
                <Money paise={figure.amount} />
              ) : figure.count !== null ? (
                figure.count
              ) : (
                (figure.note ?? <UnknownValue />)
              )}
            </Fact>
          ))}
        </Facts>
      )}

      {answer.records.length > 0 && (
        <ResponsiveTable
          caption="The records behind this answer"
          minWidth="520px"
          rows={[...answer.records]}
          rowKey={(record) => `${record.type}:${record.id}`}
          columns={[
            {
              key: "label",
              header: "Record",
              render: (record) => {
                const href = recordHref(record.type, record.id);
                return href === null ? (
                  <span>{record.label}</span>
                ) : (
                  <Link href={href} className="text-accent underline underline-offset-2">
                    {record.label}
                  </Link>
                );
              },
            },
            {
              key: "when",
              header: "When",
              secondary: true,
              render: (record) => (
                <span className="text-meta text-ink-muted">
                  {record.occurredAt === null ? "—" : formatDateTime(record.occurredAt)}
                </span>
              ),
            },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              render: (record) =>
                record.amount === null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <Money paise={record.amount} />
                ),
            },
          ]}
        />
      )}

      <Uncertainties answer={answer} />

      {answer.caveats.length > 0 && (
        <div>
          <h3 className="text-meta text-ink-muted">What this total leaves out</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {answer.caveats.map((caveat) => (
              <li key={caveat} className="text-meta text-ink-faint">
                {caveat}
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer.links.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {answer.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-body text-accent underline underline-offset-2"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}

      <p className="text-micro text-ink-faint">
        Scope: {answer.scope}.{" "}
        {answer.source === null
          ? "No read was run."
          : `Every figure above comes from ${answer.source}.`}{" "}
        Read by {result.modelInfo.provider}/{result.modelInfo.model} (
        {result.modelInfo.promptVersion}), which chose which read to run and saw none of these
        numbers. Confidence in that reading: {confidenceLabel(result.confidence).toLowerCase()}.
      </p>
    </div>
  );
}

/**
 * What the answer does not know — including a low-confidence reading of the question itself.
 *
 * Rendered as `attention` rather than folded into the prose: an answer that quietly omits how
 * sure it is of the question is exactly the failure the interpretation line exists to prevent
 * (rule 2 in `web/CLAUDE.md`, applied to a reading rather than a figure).
 */
function Uncertainties({ answer }: { answer: LedgerAnswer }) {
  if (answer.uncertainties.length === 0) return null;
  return (
    <Alert variant="attention">
      <AlertTitle>{answer.answered ? "What this answer does not know" : "Next step"}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {answer.uncertainties.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function recordHref(type: string, id: string): string | null {
  switch (type) {
    case "expense":
      return `/expenses/${id}`;
    case "payment":
      return `/payments/${id}`;
    case "finding":
      return `/splitwise/findings/${id}`;
    case "run":
      return `/reconciliation/${id}`;
    case "person":
      return `/balances?with=${id}`;
    default:
      return null;
  }
}
