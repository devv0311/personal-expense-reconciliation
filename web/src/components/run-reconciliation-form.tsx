"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { ErrorBlock } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accountTypeLabel } from "@/lib/labels";
import { currentMonthPeriod, fromDateInputValue } from "@/lib/dates";
import { parseRupeeInput } from "@/lib/money";
import { useAccounts, useRunReconciliation } from "@/lib/queries";
import type { AccountBoundaryDraft } from "@/lib/types";

interface BoundaryDraft {
  opening: string;
  openingEvidenceId: string;
  closing: string;
  closingEvidenceId: string;
}

const EMPTY: BoundaryDraft = {
  opening: "",
  openingEvidenceId: "",
  closing: "",
  closingEvidenceId: "",
};

/**
 * Running a reconciliation, and — new in phase 21 — telling it what the statements actually
 * said (ADR-0017 (cash balance), 17.5).
 *
 * The boundary section is **opt-in and it stays honest when skipped**: an account with no
 * confirmed balance is omitted from the request entirely, and the run reports that account
 * `incomplete` rather than closing it at zero. Nothing here fabricates a balance, and a balance
 * cannot be submitted without the immutable evidence it came from — the API refuses it, and so
 * does this form, because "a balance with no evidence is a number somebody typed."
 *
 * Balances are signed on purpose: an overdraft is a real balance.
 */
export function RunReconciliationForm({
  onRun,
}: {
  onRun?: (reconciliationRunId: string) => void;
}) {
  const defaults = currentMonthPeriod();
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, BoundaryDraft>>({});
  const accounts = useAccounts();
  const mutation = useRunReconciliation();

  const update = (accountId: string, patch: Partial<BoundaryDraft>) =>
    setDrafts((current) => ({
      ...current,
      [accountId]: { ...(current[accountId] ?? EMPTY), ...patch },
    }));

  const problems = collectProblems(drafts);
  const boundaries = collectBoundaries(drafts);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length > 0) return;
        mutation.mutate(
          {
            periodStart: fromDateInputValue(start),
            periodEnd: fromDateInputValue(end),
            ...(boundaries.length === 0 ? {} : { accountBoundaries: boundaries }),
          },
          { onSuccess: (result) => onRun?.(result.reconciliationRunId) },
        );
      }}
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="period-start">From</Label>
          <Input
            id="period-start"
            type="date"
            value={start}
            max={end}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="period-end">To (exclusive)</Label>
          <Input
            id="period-end"
            type="date"
            value={end}
            min={start}
            onChange={(event) => setEnd(event.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={mutation.isPending || problems.length > 0}>
          {mutation.isPending ? "Running…" : "Run reconciliation"}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-expanded={showBoundaries}
          aria-controls="statement-boundaries"
          onClick={() => setShowBoundaries((open) => !open)}
        >
          {showBoundaries ? "Hide statement balances" : "Add statement balances"}
        </Button>
      </div>

      <div id="statement-boundaries" hidden={!showBoundaries}>
        <p className="mb-4 max-w-prose text-meta text-ink-muted">
          Each balance has to cite the statement it came from, because a balance with no evidence is
          a number somebody typed. Leave an account blank and its snapshot will say so — unknown,
          never zero.
        </p>

        {accounts.isError && (
          <ErrorBlock error={accounts.error} onRetry={() => void accounts.refetch()} />
        )}

        <div className="flex flex-col gap-6">
          {(accounts.data ?? []).map((account) => {
            const draft = drafts[account.id] ?? EMPTY;
            return (
              <fieldset key={account.id} className="flex flex-col gap-3">
                <legend className="text-meta text-ink-muted">
                  {account.name}
                  <span className="text-ink-faint">
                    {" · "}
                    {accountTypeLabel(account.type)}
                    {account.last4 !== null && ` · ends ${account.last4}`}
                  </span>
                </legend>
                <div className="flex flex-wrap gap-4">
                  <BalanceField
                    id={`${account.id}-opening`}
                    label="Opening balance (₹)"
                    value={draft.opening}
                    onChange={(opening) => update(account.id, { opening })}
                  />
                  <EvidenceField
                    id={`${account.id}-opening-evidence`}
                    label="Opening statement evidence id"
                    value={draft.openingEvidenceId}
                    required={draft.opening.trim().length > 0}
                    onChange={(openingEvidenceId) => update(account.id, { openingEvidenceId })}
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <BalanceField
                    id={`${account.id}-closing`}
                    label="Closing balance (₹)"
                    value={draft.closing}
                    onChange={(closing) => update(account.id, { closing })}
                  />
                  <EvidenceField
                    id={`${account.id}-closing-evidence`}
                    label="Closing statement evidence id"
                    value={draft.closingEvidenceId}
                    required={draft.closing.trim().length > 0}
                    onChange={(closingEvidenceId) => update(account.id, { closingEvidenceId })}
                  />
                </div>
              </fieldset>
            );
          })}
        </div>

        {problems.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1 text-meta text-debit">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>

      {mutation.isError && (
        <div className="w-full">
          <ErrorBlock error={mutation.error} />
        </div>
      )}

      {mutation.isSuccess && (
        <p className="text-meta text-ink-muted" role="status">
          Recorded {mutation.data.accountSnapshots.length} account snapshot
          {mutation.data.accountSnapshots.length === 1 ? "" : "s"}. Not yet explained this period:{" "}
          <Money paise={mutation.data.totals.ledgerUnexplainedTotal} />
        </p>
      )}
    </form>
  );
}

function BalanceField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const parsed = value.trim().length === 0 ? null : parseRupeeInput(value, { allowNegative: true });
  const invalid = parsed !== null && !parsed.ok;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        placeholder="Leave blank if not confirmed"
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        className="w-52 font-mono"
      />
    </div>
  );
}

function EvidenceField({
  id,
  label,
  value,
  required,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  required: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? " (required)" : ""}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder="Evidence id"
        onChange={(event) => onChange(event.target.value)}
        className="w-72 font-mono"
      />
    </div>
  );
}

/** Only accounts with something confirmed. An untouched account is omitted, not sent as zero. */
function collectBoundaries(drafts: Record<string, BoundaryDraft>): AccountBoundaryDraft[] {
  const boundaries: AccountBoundaryDraft[] = [];
  for (const [accountId, draft] of Object.entries(drafts)) {
    const opening = parseOptional(draft.opening);
    const closing = parseOptional(draft.closing);
    if (opening === null && closing === null) continue;
    boundaries.push({
      accountId,
      ...(opening === null
        ? {}
        : { openingBalance: opening, openingBalanceEvidenceId: draft.openingEvidenceId.trim() }),
      ...(closing === null
        ? {}
        : { closingBalance: closing, closingBalanceEvidenceId: draft.closingEvidenceId.trim() }),
    });
  }
  return boundaries;
}

function collectProblems(drafts: Record<string, BoundaryDraft>): string[] {
  const problems: string[] = [];
  for (const draft of Object.values(drafts)) {
    for (const [amount, evidenceId, which] of [
      [draft.opening, draft.openingEvidenceId, "opening"],
      [draft.closing, draft.closingEvidenceId, "closing"],
    ] as const) {
      if (amount.trim().length === 0) continue;
      const parsed = parseRupeeInput(amount, { allowNegative: true });
      if (!parsed.ok) {
        problems.push(`The ${which} balance is not a valid amount: ${parsed.message}`);
      } else if (evidenceId.trim().length === 0) {
        problems.push(`The ${which} balance needs the id of the statement evidence it came from.`);
      }
    }
  }
  return problems;
}

function parseOptional(value: string): string | null {
  if (value.trim().length === 0) return null;
  const parsed = parseRupeeInput(value, { allowNegative: true });
  return parsed.ok ? parsed.paise : null;
}
