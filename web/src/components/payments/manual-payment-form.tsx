"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Money } from "@/components/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { paymentChannelLabel, referenceTypeLabel } from "@/lib/labels";
import { parseRupeeInput } from "@/lib/money";
import { useAccounts, useRecordManualPayment } from "@/lib/queries";
import {
  PAYMENT_CHANNELS,
  PAYMENT_REFERENCE_TYPES,
  type PaymentChannel,
  type PaymentDirection,
  type PaymentReferenceType,
} from "@/lib/types";

/**
 * Records a movement no statement exported — cash handed over, a wallet top-up, a transfer
 * that has not landed on an export yet.
 *
 * It is still source data, so the API still writes it through an import batch stamped
 * `manual_entry`: a payment with no provenance is a payment nobody can later explain. The row
 * lands at `imported` and takes the same normalization path as a CSV row — this form
 * classifies nothing.
 *
 * The amount is a magnitude and the direction is a separate field, deliberately: money that
 * went out is not "negative money", and a signed field is how a credit gets typed as a debit.
 */
export function ManualPaymentForm() {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<PaymentDirection>("debit");
  const [occurredOn, setOccurredOn] = useState(toDateInputValue(new Date()));
  const [description, setDescription] = useState("");
  const [channel, setChannel] = useState<PaymentChannel | "">("");
  const [externalReference, setExternalReference] = useState("");
  const [referenceType, setReferenceType] = useState<PaymentReferenceType | "">("");

  const accounts = useAccounts();
  const record = useRecordManualPayment();

  const parsed = parseRupeeInput(amount);
  const ready = accountId !== "" && description.trim().length > 0 && parsed.ok;

  const close = () => {
    setOpen(false);
    record.reset();
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Record a movement
      </Button>

      <DecisionDialog
        open={open}
        onClose={close}
        title="Record a cash movement"
        consequence={
          <>
            This writes a new payment into the ledger as source evidence, in its own{" "}
            <strong>manual entry</strong> import batch, so a later reader can tell it from an
            imported line. It lands unexplained and unclassified — recording it does not say what it
            was for.
          </>
        }
        confirmLabel="Record it"
        reasonLabel="Note for the audit trail"
        confirmDisabled={!ready}
        pending={record.isPending}
        error={record.error}
        onConfirm={() => {
          if (!parsed.ok) return;
          record.mutate(
            {
              accountId,
              amount: parsed.paise,
              direction,
              occurredAt: fromDateInputValue(occurredOn),
              description: description.trim(),
              ...(channel === "" ? {} : { channel }),
              ...(externalReference.trim() === ""
                ? {}
                : { externalReference: externalReference.trim() }),
              ...(referenceType === "" ? {} : { referenceType }),
            },
            {
              onSuccess: () => {
                setAmount("");
                setDescription("");
                setExternalReference("");
                close();
              },
            },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-account">Account</Label>
            <Select
              id="manual-account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Choose an account…</option>
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.last4 === null ? "" : ` ••${account.last4}`}
                </option>
              ))}
            </Select>
            {accounts.isSuccess && accounts.data.length === 0 && (
              <p className="text-meta text-attention">
                No accounts exist yet. Add one in Setup first — a movement with no account has
                nowhere to reconcile against.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-amount">Amount</Label>
              <Input
                id="manual-amount"
                inputMode="decimal"
                placeholder="1,200.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-40 font-mono"
              />
              {amount.trim() !== "" && !parsed.ok && (
                <p className="text-meta text-attention">{parsed.message}</p>
              )}
              {parsed.ok && (
                <p className="text-micro text-ink-faint">
                  Reads as <Money paise={parsed.paise} />
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-direction">Direction</Label>
              <Select
                id="manual-direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as PaymentDirection)}
                className="w-40"
              >
                <option value="debit">Money out (debit)</option>
                <option value="credit">Money in (credit)</option>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-date">Date</Label>
              <Input
                id="manual-date"
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-description">What it was</Label>
            <Input
              id="manual-description"
              value={description}
              placeholder="Cash to Priya for the cab"
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="text-micro text-ink-faint">
              Stored as the movement&apos;s permanent narration, exactly as typed. It is never
              overwritten by an interpretation of it.
            </p>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-channel">Channel</Label>
              <Select
                id="manual-channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value as PaymentChannel | "")}
                className="w-44"
              >
                <option value="">Not stated</option>
                {PAYMENT_CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {paymentChannelLabel(option)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-reference">Reference</Label>
              <Input
                id="manual-reference"
                value={externalReference}
                placeholder="UTR or order id"
                onChange={(event) => setExternalReference(event.target.value)}
                className="w-52 font-mono"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-reference-type">Reference type</Label>
              <Select
                id="manual-reference-type"
                value={referenceType}
                onChange={(event) =>
                  setReferenceType(event.target.value as PaymentReferenceType | "")
                }
                className="w-44"
              >
                <option value="">Not stated</option>
                {PAYMENT_REFERENCE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {referenceTypeLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {!ready && (
            <p className="text-meta text-ink-muted">
              An account, an amount and a description are required before this can be recorded.
            </p>
          )}
        </div>
      </DecisionDialog>
    </>
  );
}
