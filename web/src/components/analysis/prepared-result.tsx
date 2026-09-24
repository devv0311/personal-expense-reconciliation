"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import type { AnalysisResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * What the system found, said the way somebody would say it.
 *
 * This replaced a button called **Analyze records** and the report it produced. Both were
 * accurate. Neither was something a person came to do: reading a statement is what importing it
 * is *for*, and a product that imports a file and then waits to be told to look at it has asked
 * its reader to understand its own internals.
 *
 * So the reading happens on its own and this says what came of it. The wording is deliberately
 * about outcomes — things to confirm, records read, nothing found — and never about stages,
 * pipelines, models or analysis. The one number that leads is **how many questions are waiting**,
 * because that is the only one a person can act on.
 *
 * **It never says everything is settled when it is not.** `complete` is the API's own flag; a
 * run with a stage that could not finish says so, in a sentence, rather than rounding up to
 * "done".
 */
export function PreparedResult({
  result,
  heading,
}: {
  result: AnalysisResult;
  /** Overrides the opening line where the surrounding screen has already said what happened. */
  heading?: string;
}) {
  const questions = result.questionsForYou;

  return (
    <div className="flex flex-col items-start gap-3 rounded-sm border border-rule bg-panel p-5">
      <div>
        <h3 className="text-emphasis font-medium text-ink">{heading ?? headline(result)}</h3>
        <p className="mt-1 max-w-prose text-meta text-ink-muted">{explanation(result)}</p>
      </div>

      {questions > 0 && (
        <Link href="/needs-attention" className={buttonVariants({ size: "sm" })}>
          Review suggestions
        </Link>
      )}

      {result.notUnderstood > 0 && (
        <p className="max-w-prose text-meta text-ink-muted">
          {result.notUnderstood} {result.notUnderstood === 1 ? "payment" : "payments"} said nothing
          about what they were for. They are on file, and they show up under Spending as money with
          no story yet.
        </p>
      )}

      {/*
        A stage that could not finish is named here and nowhere else on a primary screen: a
        person cannot act on it, and hiding it would let an unfinished run read as a finished
        one. The sentence is the API's own, written for a reader rather than an operator.
      */}
      {!result.complete && <Unfinished result={result} />}
    </div>
  );
}

/** The opening line, chosen by what there is to do about it. */
function headline(result: AnalysisResult): string {
  const questions = result.questionsForYou;
  if (questions === 0) {
    return result.recordsChecked === 0
      ? "Nothing new to read"
      : "Read everything — nothing needs you";
  }
  if (questions === 1) return "I found one thing to confirm";
  return `I found ${questions === 2 ? "a couple of" : "a few"} things to confirm`;
}

function explanation(result: AnalysisResult): string {
  if (result.questionsForYou === 0) {
    return result.recordsChecked === 0
      ? "Everything on file has already been read."
      : "Everything read so far either explains itself or is already connected to something else.";
  }
  const suggested =
    result.suggestionsReady > 0
      ? `${result.suggestionsReady} ${result.suggestionsReady === 1 ? "payment has" : "payments have"} a suggested category waiting for you to agree with`
      : "";
  const connected =
    result.connectionsFound > 0
      ? `${result.connectionsFound} ${result.connectionsFound === 1 ? "record looks" : "records look"} like they belong to a payment already on file`
      : "";
  const parts = [suggested, connected].filter((part) => part !== "");
  const detail = parts.length === 0 ? "" : `${parts.join(", and ")}. `;
  return `${detail}Nothing has been decided — nothing counts as spending, and nobody owes anything, until you say so.`;
}

function Unfinished({ result }: { result: AnalysisResult }) {
  const unfinished = result.stages.filter((stage) => stage.status !== "done");
  return (
    <div className={cn("border-t border-rule pt-3", "w-full")}>
      <p className="text-micro text-ink-faint">Not everything could be worked out:</p>
      <ul className="mt-1 flex max-w-prose flex-col gap-1">
        {unfinished.map((stage) => (
          <li key={stage.name} className="text-meta text-ink-muted">
            {stage.unfinishedReason ?? stage.summary}
          </li>
        ))}
      </ul>
    </div>
  );
}
