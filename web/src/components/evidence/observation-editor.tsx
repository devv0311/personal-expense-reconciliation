"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { toDateInputValue, fromDateInputValue } from "@/lib/dates";
import { referenceTypeLabel } from "@/lib/labels";
import { parseRupeeInput, toRupeeInput } from "@/lib/money";
import { useRecordEvidenceObservation } from "@/lib/queries";
import {
  PAYMENT_REFERENCE_TYPES,
  type EvidenceObservationView,
  type PaymentDirection,
  type PaymentReferenceType,
} from "@/lib/types";

/**
 * Correcting what was read off a document.
 *
 * This is the fix for a parse the grammar got wrong — an amount read from the wrong number, a
 * direction inverted by unusual wording. It replaces the **reading**; the `Evidence` row is
 * source and is never touched (`invariants.md` #2). A corrected reading changes which payments
 * the matcher would offer next, and nothing else: no link is made or unmade here.
 */
export function ObservationEditor({
  evidenceId,
  observation,
}: {
  evidenceId: string;
  observation: EvidenceObservationView | null;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<PaymentDirection | "">("");
  const [reference, setReference] = useState("");
  const [referenceType, setReferenceType] = useState<PaymentReferenceType | "">("");
  const [merchantText, setMerchantText] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const record = useRecordEvidenceObservation(evidenceId);

  const openEditor = () => {
    setAmount(
      observation?.observedAmount === null || observation === null
        ? ""
        : toRupeeInput(observation.observedAmount),
    );
    setDirection(observation?.observedDirection ?? "");
    setReference(observation?.observedReference ?? "");
    setReferenceType((observation?.observedReferenceType as PaymentReferenceType | null) ?? "");
    setMerchantText(observation?.observedMerchantText ?? "");
    setOccurredOn(
      observation?.observedOccurredAt == null
        ? ""
        : toDateInputValue(new Date(observation.observedOccurredAt)),
    );
    record.reset();
    setOpen(true);
  };

  const parsed = amount.trim() === "" ? null : parseRupeeInput(amount);
  const amountInvalid = parsed !== null && !parsed.ok;

  return (
    <>
      <Button variant="outline" size="sm" onClick={openEditor}>
        {observation === null ? "Record what it says" : "Correct this reading"}
      </Button>

      <DecisionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={observation === null ? "Record what this document says" : "Correct this reading"}
        consequence={
          <>
            This replaces the structured reading of the document. The document itself is untouched —
            it is the source, and a correction never rewrites it. A field left empty is recorded as{" "}
            <strong>not stated</strong>, which is a different fact from zero.
          </>
        }
        confirmLabel="Record it"
        confirmDisabled={amountInvalid}
        reasonLabel="What the reading got wrong"
        pending={record.isPending}
        error={record.error}
        onConfirm={(reason) => {
          record.mutate(
            {
              observedAmount: parsed !== null && parsed.ok ? parsed.paise : null,
              observedDirection: direction === "" ? null : direction,
              observedReference: reference.trim() === "" ? null : reference.trim(),
              observedReferenceType: referenceType === "" ? null : referenceType,
              observedMerchantText: merchantText.trim() === "" ? null : merchantText.trim(),
              observedOccurredAt: occurredOn === "" ? null : fromDateInputValue(occurredOn),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="observed-amount">Amount</Label>
              <Input
                id="observed-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-36 font-mono"
              />
              {amountInvalid && parsed !== null && !parsed.ok && (
                <p className="text-meta text-attention">{parsed.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="observed-direction">Direction</Label>
              <Select
                id="observed-direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as PaymentDirection | "")}
                className="w-40"
              >
                <option value="">Not stated</option>
                <option value="debit">Money out</option>
                <option value="credit">Money in</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="observed-date">Instant</Label>
              <Input
                id="observed-date"
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="observed-reference">Reference</Label>
              <Input
                id="observed-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                className="w-52 font-mono"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="observed-reference-type">Reference type</Label>
              <Select
                id="observed-reference-type"
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="observed-merchant">Merchant text</Label>
            <Input
              id="observed-merchant"
              value={merchantText}
              onChange={(event) => setMerchantText(event.target.value)}
            />
          </div>
        </div>
      </DecisionDialog>
    </>
  );
}
