"use client";

import { useState } from "react";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import {
  cashFlowCategoryGate,
  cashFlowCategoryLabel,
  cashFlowStateLabel,
  counterpartyTypeDetail,
  counterpartyTypeLabel,
} from "@/lib/labels";
import {
  useCounterpartyOptions,
  useDecidePaymentCashFlow,
  usePayment,
  useSetPaymentCounterparty,
} from "@/lib/queries";
import {
  CASH_FLOW_CATEGORIES,
  CREDIT_ONLY_CASH_FLOW_CATEGORIES,
  PAYMENT_COUNTERPARTY_TYPES,
  type CashFlowCategory,
  type PaymentCounterpartyType,
  type PaymentWorkspaceItem,
} from "@/lib/types";

/**
 * The two interpretations a person records against one movement: who was on the other side,
 * and what role the money played.
 *
 * They are deliberately separate controls because they are separate questions (ADR-0017,
 * 17.1): `counterpartyType` answers *who*, `cashFlowCategory` answers *what for*. A payment to
 * a friend can be a settlement or a shared purchase, and neither field can be derived from the
 * other.
 *
 * Nothing here approves anything on the ledger's behalf. Approval is its own step, its
 * evidence gate is stated before the button, and the service re-checks it regardless.
 */
export function CashFlowDecisions({ paymentId }: { paymentId: string }) {
  const payment = usePayment(paymentId);

  if (payment.isPending) {
    return (
      <LoadingStatus label="Loading this movement's interpretation…">
        <TableSkeleton columns={2} rows={3} />
      </LoadingStatus>
    );
  }
  if (payment.isError) {
    return <ErrorBlock error={payment.error} onRetry={() => void payment.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <CounterpartySection payment={payment.data} />
      <CashFlowSection payment={payment.data} />
    </div>
  );
}

/* ------------------------------------------------------------------------ counterparty */

function CounterpartySection({ payment }: { payment: PaymentWorkspaceItem }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<PaymentCounterpartyType>(payment.counterpartyType);
  const [id, setId] = useState(payment.counterpartyId ?? "");
  const options = useCounterpartyOptions();
  const save = useSetPaymentCounterparty();

  const needsId = type === "merchant" || type === "person" || type === "internal_account";
  const candidates =
    type === "merchant"
      ? (options.data?.merchants ?? []).map((entry) => ({
          id: entry.id,
          name: entry.canonicalName,
        }))
      : type === "person"
        ? (options.data?.people ?? []).map((entry) => ({ id: entry.id, name: entry.displayName }))
        : type === "internal_account"
          ? (options.data?.accounts ?? []).map((entry) => ({ id: entry.id, name: entry.name }))
          : [];

  return (
    <Section
      title="Who was on the other side"
      headingId="counterparty"
      description="A transfer between your own accounts and an investment purchase are not spending, and this is where that is said (invariant #7)."
      actions={
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {payment.counterpartyType === "unknown" ? "Say who" : "Change"}
        </Button>
      }
    >
      <Facts>
        <Fact label="Counterparty type">{counterpartyTypeLabel(payment.counterpartyType)}</Fact>
        <Fact label="Resolved to">
          {payment.counterpartyName ?? <UnknownValue>Nobody named</UnknownValue>}
        </Fact>
      </Facts>
      <p className="mt-2 text-meta text-ink-muted">
        {counterpartyTypeDetail(payment.counterpartyType)}
      </p>

      <DecisionDialog
        open={open}
        onClose={() => {
          setOpen(false);
          save.reset();
        }}
        title="Say what the other side was"
        consequence={
          <>
            This records your interpretation against the movement. Marking it{" "}
            <strong>own account</strong> or <strong>investment</strong> takes it out of spending
            entirely — no expense may then be linked to it. The original narration is untouched.
          </>
        }
        confirmLabel="Record it"
        confirmDisabled={needsId && id === ""}
        reasonLabel="Why"
        pending={save.isPending}
        error={save.error}
        onConfirm={(reason) => {
          save.mutate(
            {
              paymentId: payment.id,
              counterpartyType: type,
              ...(needsId && id !== "" ? { counterpartyId: id } : {}),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="counterparty-type">Type</Label>
            <Select
              id="counterparty-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as PaymentCounterpartyType);
                setId("");
              }}
            >
              {PAYMENT_COUNTERPARTY_TYPES.map((option) => (
                <option key={option} value={option}>
                  {counterpartyTypeLabel(option)}
                </option>
              ))}
            </Select>
            <p className="text-micro text-ink-faint">{counterpartyTypeDetail(type)}</p>
          </div>

          {needsId && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="counterparty-id">Which one</Label>
              <Select
                id="counterparty-id"
                value={id}
                onChange={(event) => setId(event.target.value)}
              >
                <option value="">Choose…</option>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
              {options.isSuccess && candidates.length === 0 && (
                <p className="text-meta text-attention">
                  None exist yet. Add one in Setup, then come back.
                </p>
              )}
            </div>
          )}
        </div>
      </DecisionDialog>
    </Section>
  );
}

/* --------------------------------------------------------------------- the cash-flow role */

function CashFlowSection({ payment }: { payment: PaymentWorkspaceItem }) {
  const [step, setStep] = useState<"normalize" | "classify" | "approve" | "reject" | null>(null);
  const [category, setCategory] = useState<CashFlowCategory>("PEER_SETTLEMENT");
  const [counterLeg, setCounterLeg] = useState("");
  const decide = useDecidePaymentCashFlow();

  const close = () => {
    setStep(null);
    decide.reset();
  };

  const allowedCategories = CASH_FLOW_CATEGORIES.filter(
    (option) =>
      payment.direction === "credit" || !CREDIT_ONLY_CASH_FLOW_CATEGORIES.includes(option),
  );

  return (
    <Section
      title="What the money was doing"
      headingId="cash-flow"
      description="A settlement, a refund, a transfer between your own accounts, or income. Ordinary purchases have no category at all — that is not a gap."
      actions={
        <div className="flex flex-wrap gap-2">
          {payment.cashFlowState === "imported" && (
            <Button variant="outline" size="sm" onClick={() => setStep("normalize")}>
              Ready it
            </Button>
          )}
          {payment.cashFlowState === "normalized" && (
            <Button variant="outline" size="sm" onClick={() => setStep("classify")}>
              Propose a role
            </Button>
          )}
          {payment.cashFlowState === "cash_flow_classified" && (
            <>
              <Button size="sm" onClick={() => setStep("approve")}>
                Approve
              </Button>
              <Button variant="outline" size="sm" onClick={() => setStep("reject")}>
                Decline
              </Button>
            </>
          )}
        </div>
      }
    >
      <Facts>
        <Fact label="Stage">{cashFlowStateLabel(payment.cashFlowState)}</Fact>
        <Fact label="Role">
          {payment.cashFlowCategory === null ? (
            <UnknownValue>No category — an ordinary movement, or nobody has said</UnknownValue>
          ) : (
            cashFlowCategoryLabel(payment.cashFlowCategory)
          )}
        </Fact>
        {payment.cashFlowState === "approved" && (
          <Fact label="Approved">
            {payment.cashFlowApprovedBy ?? "Unknown actor"}
            {payment.cashFlowApprovedAt === null
              ? ""
              : `, ${formatDateTime(payment.cashFlowApprovedAt)}`}
          </Fact>
        )}
      </Facts>

      <DecisionDialog
        open={step === "normalize"}
        onClose={close}
        title="Ready this movement for a cash-flow decision"
        consequence={
          <>
            This moves it from <strong>not started</strong> to <strong>ready to classify</strong>.
            It records no category and explains nothing.
          </>
        }
        confirmLabel="Ready it"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          decide.mutate(
            {
              paymentId: payment.id,
              step: "normalize",
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: close },
          );
        }}
      />

      <DecisionDialog
        open={step === "classify"}
        onClose={close}
        title="Propose what this movement was for"
        consequence={
          <>
            This records a proposed role. It is <strong>not</strong> approval: nothing counts this
            movement as a settlement, refund or transfer until the separate approval step, which
            checks the evidence for the category you choose.
          </>
        }
        confirmLabel="Propose it"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          decide.mutate(
            {
              paymentId: payment.id,
              step: "classify",
              category,
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: close },
          );
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cash-flow-category">Role</Label>
          <Select
            id="cash-flow-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as CashFlowCategory)}
          >
            {allowedCategories.map((option) => (
              <option key={option} value={option}>
                {cashFlowCategoryLabel(option)}
              </option>
            ))}
          </Select>
          <p className="text-micro text-ink-faint">{cashFlowCategoryGate(category)}</p>
          {payment.direction === "debit" && (
            <p className="text-micro text-ink-faint">
              A refund and an external inflow can only ever describe money coming in, so neither is
              offered for a debit.
            </p>
          )}
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={step === "approve"}
        onClose={close}
        title="Approve this cash-flow role"
        consequence={
          <>
            This is the decision every cash-explanation read depends on: once approved, the movement
            counts as{" "}
            <strong>
              {payment.cashFlowCategory === null
                ? "the proposed role"
                : cashFlowCategoryLabel(payment.cashFlowCategory)}
            </strong>{" "}
            in each account&apos;s cash identity. It is refused unless the evidence is already
            recorded —{" "}
            {payment.cashFlowCategory === null
              ? "the category's own gate applies"
              : cashFlowCategoryGate(payment.cashFlowCategory)}
          </>
        }
        confirmLabel="Approve"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          decide.mutate(
            {
              paymentId: payment.id,
              step: "approve",
              ...(counterLeg.trim() === "" ? {} : { counterLegPaymentId: counterLeg.trim() }),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: close },
          );
        }}
      >
        {payment.cashFlowCategory === "INTERNAL_TRANSFER" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="counter-leg">Counter-leg payment id</Label>
            <Input
              id="counter-leg"
              value={counterLeg}
              placeholder="The matching movement on the other account"
              onChange={(event) => setCounterLeg(event.target.value)}
              className="font-mono text-meta"
            />
            <p className="text-micro text-ink-faint">
              A transfer is cash-neutral only when both legs are known. Without one, approval is
              refused rather than assumed — an unpaired leg stays visible instead of quietly
              cancelling.
            </p>
          </div>
        )}
      </DecisionDialog>

      <DecisionDialog
        open={step === "reject"}
        onClose={close}
        title="Decline this proposed role"
        consequence={
          <>
            This clears the proposed category and sends the movement back to{" "}
            <strong>ready to classify</strong>. Leaving a declined label on the row would mean a
            credit nobody agreed about still reads as classified.
          </>
        }
        confirmLabel="Decline it"
        confirmVariant="outline"
        reasonRequired
        reasonPlaceholder="What was wrong with it"
        pending={decide.isPending}
        error={decide.error}
        onConfirm={(reason) => {
          if (reason === undefined) return;
          decide.mutate({ paymentId: payment.id, step: "reject", reason }, { onSuccess: close });
        }}
      />
    </Section>
  );
}
