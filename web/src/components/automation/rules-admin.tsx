"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import {
  cashFlowCategoryLabel,
  counterpartyTypeLabel,
  paymentChannelLabel,
  ruleActionLabel,
  ruleEffectDetail,
  ruleEffectLabel,
  ruleOperatorLabel,
  ruleOutcomeLabel,
} from "@/lib/labels";
import { parseRupeeInput } from "@/lib/money";
import { useApplyRules, useCreateRule, useRules, useUpdateRule } from "@/lib/queries";
import {
  CASH_FLOW_CATEGORIES,
  PAYMENT_CHANNELS,
  PAYMENT_COUNTERPARTY_TYPES,
  RULE_TEXT_OPERATORS,
  type ApplyRulesResult,
  type CashFlowCategory,
  type PaymentChannel,
  type PaymentCounterpartyType,
  type PaymentDirection,
  type RuleAssertion,
  type RuleEffect,
  type RuleTextOperator,
  type RuleView,
} from "@/lib/types";

/**
 * Standing rules: a decision a person already made, written down so it does not have to be
 * made again.
 *
 * Three properties make that safe, and all three are visible on this screen:
 *
 * - **A rule asserts one label, never an amount.** No rule touches an allocation, a share or a
 *   figure — only what kind of thing a payment is.
 * - **`propose` is the default and `apply` is opt-in per rule.** An applied write is
 *   attributed to `rule:<id>`, never to a person (`invariants.md` #17), so the audit trail
 *   never claims somebody looked at it.
 * - **A payment two rules both match is a conflict, and is left alone.** Applying one of them
 *   would hide a disagreement between two things the same person wrote down.
 *
 * Cash-flow rules classify; they never approve. ADR-0017's evidence gates still stand between
 * a category and an approval, whichever way the category was set.
 */
export function RulesAdmin() {
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState<"preview" | "apply" | null>(null);
  const [result, setResult] = useState<ApplyRulesResult | null>(null);
  const [dryRunResult, setDryRunResult] = useState<ApplyRulesResult | null>(null);

  const rules = useRules();
  const create = useCreateRule();
  const update = useUpdateRule();
  const apply = useApplyRules();

  return (
    <Section
      title="Standing rules"
      headingId="rules"
      description="Each one restates a call you have already made, over payments that match it exactly. No rule decides an amount."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setRunning("preview")}>
            Preview a run
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Write a rule
          </Button>
        </div>
      }
    >
      {rules.isPending && (
        <LoadingStatus label="Loading rules…">
          <TableSkeleton columns={3} />
        </LoadingStatus>
      )}
      {rules.isError && <ErrorBlock error={rules.error} onRetry={() => void rules.refetch()} />}
      {rules.isSuccess && rules.data.length === 0 && (
        <EmptyBlock>
          No rules. Every payment is interpreted one at a time, which is the safe default — a rule
          is worth writing once you have made the same call three times.
        </EmptyBlock>
      )}
      {rules.isSuccess && rules.data.length > 0 && (
        <ul className="flex flex-col">
          {rules.data.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-3 last:border-b-0"
            >
              <div>
                <p className="text-body text-ink">
                  {rule.name}
                  {!rule.active && <span className="ml-2 text-micro text-ink-faint">inactive</span>}
                  {rule.effect === "apply" && (
                    <span className="ml-2 text-micro text-attention">applies unattended</span>
                  )}
                </p>
                <p className="mt-0.5 text-meta text-ink-muted">
                  {describeMatch(rule)} → {describeAssertion(rule.assertion)}
                </p>
                <p className="mt-0.5 text-micro text-ink-faint">
                  Applied {rule.timesApplied} {rule.timesApplied === 1 ? "time" : "times"}
                  {rule.lastAppliedAt === null
                    ? ""
                    : `, last on ${formatDateTime(rule.lastAppliedAt)}`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="link"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ ruleId: rule.id, active: !rule.active })}
                >
                  {rule.active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {dryRunResult !== null && <RunOutcome result={dryRunResult} preview />}
      {result !== null && <RunOutcome result={result} preview={false} />}

      <NewRuleDialog
        open={adding}
        onClose={() => setAdding(false)}
        pending={create.isPending}
        error={create.error}
        onCreate={(input) => create.mutate(input, { onSuccess: () => setAdding(false) })}
      />

      <DecisionDialog
        open={running === "preview"}
        onClose={() => {
          setRunning(null);
          apply.reset();
        }}
        title="Preview what these rules would do"
        consequence={
          <>
            This writes <strong>nothing</strong>. It reports what each rule would assert over the
            payments waiting to be interpreted, including any a second rule also matches.
          </>
        }
        confirmLabel="Preview it"
        pending={apply.isPending}
        error={apply.error}
        onConfirm={() => {
          apply.mutate(
            { dryRun: true },
            {
              onSuccess: (outcome) => {
                setDryRunResult(outcome);
                setResult(null);
                setRunning(null);
              },
            },
          );
        }}
      />

      <DecisionDialog
        open={running === "apply"}
        onClose={() => {
          setRunning(null);
          apply.reset();
        }}
        title="Run these rules for real"
        consequence={
          <>
            Rules set to <strong>apply</strong> will write their fact without further asking,
            attributed to the rule rather than to you. Rules set to <strong>propose</strong> record
            a suggestion for the review queue. Nothing here approves a cash-flow role or touches any
            amount.
          </>
        }
        confirmLabel="Run them"
        pending={apply.isPending}
        error={apply.error}
        onConfirm={() => {
          apply.mutate(
            {},
            {
              onSuccess: (outcome) => {
                setResult(outcome);
                setDryRunResult(null);
                setRunning(null);
              },
            },
          );
        }}
      />

      {dryRunResult !== null && (
        <div className="mt-4">
          <Button onClick={() => setRunning("apply")}>Run them for real</Button>
        </div>
      )}
    </Section>
  );
}

function RunOutcome({ result, preview }: { result: ApplyRulesResult; preview: boolean }) {
  if (result.outcomes.length === 0 && result.conflicts.length === 0) {
    return (
      <Alert variant="attention" className="mt-4">
        <AlertTitle>No payment matched a rule</AlertTitle>
        <AlertDescription>
          <p>Nothing waiting to be interpreted matched any active rule.</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="attention" className="mt-4">
      <AlertTitle>{preview ? "This is what a run would do" : "What the run did"}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 flex flex-col gap-1 text-meta">
          {result.outcomes.map((outcome, index) => (
            <li key={`${outcome.paymentId}-${index}`}>
              {ruleOutcomeLabel(outcome.outcome)} — {outcome.ruleName}:{" "}
              {describeAssertion(outcome.assertion)}
              {outcome.reason !== undefined && ` (${outcome.reason})`}
            </li>
          ))}
        </ul>
        {result.conflicts.length > 0 && (
          <p className="mt-2 text-meta">
            {result.conflicts.length}{" "}
            {result.conflicts.length === 1 ? "payment matched" : "payments matched"} more than one
            rule and {result.conflicts.length === 1 ? "was" : "were"} left alone — two rules
            disagreeing is something only you can settle.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function NewRuleDialog({
  open,
  onClose,
  pending,
  error,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  error: unknown;
  onCreate: (input: Parameters<ReturnType<typeof useCreateRule>["mutate"]>[0]) => void;
}) {
  const [name, setName] = useState("");
  const [operator, setOperator] = useState<RuleTextOperator>("contains");
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<PaymentDirection | "">("");
  const [channel, setChannel] = useState<PaymentChannel | "">("");
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState<RuleAssertion["action"]>("set_counterparty_type");
  const [counterpartyType, setCounterpartyType] = useState<PaymentCounterpartyType>("merchant");
  const [cashFlowCategory, setCashFlowCategory] = useState<CashFlowCategory>("PEER_SETTLEMENT");
  const [category, setCategory] = useState("");
  const [effect, setEffect] = useState<RuleEffect>("propose");

  const parsedAmount = amount.trim() === "" ? null : parseRupeeInput(amount);
  const hasCondition =
    description.trim() !== "" ||
    direction !== "" ||
    channel !== "" ||
    (parsedAmount !== null && parsedAmount.ok);
  const assertionReady = action !== "set_expense_category" || category.trim() !== "";
  const ready = name.trim() !== "" && hasCondition && assertionReady;

  const assertion: RuleAssertion =
    action === "set_counterparty_type"
      ? { action, counterpartyType }
      : action === "set_cash_flow_category"
        ? { action, cashFlowCategory }
        : { action, category: category.trim() };

  return (
    <DecisionDialog
      open={open}
      onClose={onClose}
      title="Write a standing rule"
      consequence={
        effect === "apply" ? (
          <>
            This rule will <strong>write its fact without asking</strong> on every payment it
            matches from now on, attributed to the rule rather than to you. Only write one when you
            would make the same call every time without looking.
          </>
        ) : (
          <>
            This rule will <strong>propose</strong> its fact for the review queue. It writes nothing
            on its own, and every proposal is still yours to accept or reject.
          </>
        )
      }
      confirmLabel="Write it"
      confirmDisabled={!ready}
      reasonLabel="Note for the audit trail"
      pending={pending}
      error={error}
      onConfirm={(reason) => {
        if (!ready) return;
        onCreate({
          name: name.trim(),
          match: {
            ...(description.trim() === ""
              ? {}
              : { description: description.trim(), descriptionOperator: operator }),
            ...(direction === "" ? {} : { direction }),
            ...(channel === "" ? {} : { channel }),
            ...(parsedAmount !== null && parsedAmount.ok ? { amount: parsedAmount.paise } : {}),
          },
          assertion,
          effect,
          ...(reason === undefined ? {} : { reason }),
        });
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-name">Name</Label>
          <Input
            id="rule-name"
            value={name}
            placeholder="Rent to the landlord"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta text-ink-muted">When a payment&apos;s…</legend>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-operator">Narration</Label>
              <Select
                id="rule-operator"
                value={operator}
                onChange={(event) => setOperator(event.target.value as RuleTextOperator)}
                className="w-36"
              >
                {RULE_TEXT_OPERATORS.map((option) => (
                  <option key={option} value={option}>
                    {ruleOperatorLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              aria-label="Narration text"
              value={description}
              placeholder="NEFT-LANDLORD"
              onChange={(event) => setDescription(event.target.value)}
              className="w-56 font-mono text-meta"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-direction">Direction</Label>
              <Select
                id="rule-direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as PaymentDirection | "")}
                className="w-40"
              >
                <option value="">Either</option>
                <option value="debit">Money out</option>
                <option value="credit">Money in</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-channel">Channel</Label>
              <Select
                id="rule-channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value as PaymentChannel | "")}
                className="w-40"
              >
                <option value="">Any</option>
                {PAYMENT_CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {paymentChannelLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-amount">Exact amount</Label>
              <Input
                id="rule-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-36 font-mono"
              />
              <p className="text-micro text-ink-faint">
                Exact. A rule about roughly ₹500 is a judgement, not a rule.
              </p>
            </div>
          </div>
          {!hasCondition && (
            <p className="text-meta text-attention">
              A rule needs at least one condition. One that matched everything would be a default,
              and defaults belong in code where they can be read.
            </p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-meta text-ink-muted">…assert that</legend>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-action">Fact</Label>
              <Select
                id="rule-action"
                value={action}
                onChange={(event) => setAction(event.target.value as RuleAssertion["action"])}
                className="w-56"
              >
                <option value="set_counterparty_type">
                  {ruleActionLabel("set_counterparty_type")}
                </option>
                <option value="set_cash_flow_category">
                  {ruleActionLabel("set_cash_flow_category")}
                </option>
                <option value="set_expense_category">
                  {ruleActionLabel("set_expense_category")}
                </option>
              </Select>
            </div>
            {action === "set_counterparty_type" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-counterparty">To</Label>
                <Select
                  id="rule-counterparty"
                  value={counterpartyType}
                  onChange={(event) =>
                    setCounterpartyType(event.target.value as PaymentCounterpartyType)
                  }
                  className="w-44"
                >
                  {PAYMENT_COUNTERPARTY_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {counterpartyTypeLabel(option)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {action === "set_cash_flow_category" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-cash-flow">To</Label>
                <Select
                  id="rule-cash-flow"
                  value={cashFlowCategory}
                  onChange={(event) => setCashFlowCategory(event.target.value as CashFlowCategory)}
                  className="w-48"
                >
                  {CASH_FLOW_CATEGORIES.map((option) => (
                    <option key={option} value={option}>
                      {cashFlowCategoryLabel(option)}
                    </option>
                  ))}
                </Select>
                <p className="text-micro text-ink-faint">
                  Classifies only. Approving it still needs its evidence.
                </p>
              </div>
            )}
            {action === "set_expense_category" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-category">To</Label>
                <Input
                  id="rule-category"
                  value={category}
                  placeholder="rent"
                  onChange={(event) => setCategory(event.target.value)}
                  className="w-44"
                />
              </div>
            )}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-effect">And then</Label>
          <Select
            id="rule-effect"
            value={effect}
            onChange={(event) => setEffect(event.target.value as RuleEffect)}
            className="w-56"
          >
            <option value="propose">{ruleEffectLabel("propose")}</option>
            <option value="apply">{ruleEffectLabel("apply")}</option>
          </Select>
          <p className="max-w-prose text-micro text-ink-faint">{ruleEffectDetail(effect)}</p>
        </div>
      </div>
    </DecisionDialog>
  );
}

/** The rule's own conditions, read back as a sentence. */
function describeMatch(rule: RuleView): string {
  const parts: string[] = [];
  if (rule.match.description !== undefined) {
    parts.push(
      `narration ${ruleOperatorLabel(rule.match.descriptionOperator ?? "contains")} "${rule.match.description}"`,
    );
  }
  if (rule.match.direction !== undefined) {
    parts.push(rule.match.direction === "debit" ? "money out" : "money in");
  }
  if (rule.match.channel !== undefined) {
    parts.push(`over ${paymentChannelLabel(rule.match.channel)}`);
  }
  if (rule.match.amount !== undefined) parts.push("an exact amount");
  return parts.length === 0 ? "Matches everything" : parts.join(", ");
}

function describeAssertion(assertion: RuleAssertion): string {
  switch (assertion.action) {
    case "set_counterparty_type":
      return `${ruleActionLabel(assertion.action)}: ${counterpartyTypeLabel(assertion.counterpartyType)}`;
    case "set_cash_flow_category":
      return `${ruleActionLabel(assertion.action)}: ${cashFlowCategoryLabel(assertion.cashFlowCategory)}`;
    case "set_expense_category":
      return `${ruleActionLabel(assertion.action)}: ${assertion.category}`;
  }
}
