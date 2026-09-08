"use client";

import { useState } from "react";
import { Confidence, NoteList } from "@/components/annotations";
import { Fact, Facts, UnknownValue } from "@/components/facts";
import { Money } from "@/components/money";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { parseRupeeInput, toRupeeInput } from "@/lib/money";
import { useConfirmReceipt, useCorrectReceipt, useReceipt } from "@/lib/queries";
import type { ReceiptView } from "@/lib/types";

/**
 * The extracted receipt behind a document, with the two decisions a person can take on it.
 *
 * The audit found this component built and never mounted — a receipt's items, tax and
 * discrepancies existed in code and appeared on no screen, so an extraction could be neither
 * read in full nor confirmed nor corrected (row 15, failure 3). Mounting it is most of the fix;
 * the rest is these two controls.
 *
 * **Confirming** records that a person read the extraction and accepts it — the state every
 * downstream use of a receipt total depends on. **Correcting** overwrites what the model read.
 * Neither changes the document, and neither moves an expense: a receipt is what a shop printed,
 * and `Expense.amount` is immutable once approved (`invariants.md` #6).
 */
export function ReceiptReview({ receiptId }: { receiptId: string }) {
  const receipt = useReceipt(receiptId);
  const [correcting, setCorrecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [total, setTotal] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");

  const confirm = useConfirmReceipt(receiptId);
  const correct = useCorrectReceipt(receiptId);

  if (receipt.isPending) {
    return (
      <Section title="What the receipt says" headingId="receipt">
        <LoadingStatus label="Loading the extracted receipt…">
          <TableSkeleton columns={3} rows={3} />
        </LoadingStatus>
      </Section>
    );
  }
  if (receipt.isError) {
    return (
      <Section title="What the receipt says" headingId="receipt">
        <ErrorBlock error={receipt.error} onRetry={() => void receipt.refetch()} />
      </Section>
    );
  }

  const view = receipt.data;
  const openCorrection = () => {
    setTotal(view.receipt.total === null ? "" : toRupeeInput(view.receipt.total));
    setSubtotal(view.receipt.subtotal === null ? "" : toRupeeInput(view.receipt.subtotal));
    setTax(view.receipt.tax === null ? "" : toRupeeInput(view.receipt.tax));
    correct.reset();
    setCorrecting(true);
  };

  const parsedTotal = total.trim() === "" ? null : parseRupeeInput(total);
  const parsedSubtotal = subtotal.trim() === "" ? null : parseRupeeInput(subtotal);
  const parsedTax = tax.trim() === "" ? null : parseRupeeInput(tax);
  const anyInvalid = [parsedTotal, parsedSubtotal, parsedTax].some(
    (parsed) => parsed !== null && !parsed.ok,
  );

  return (
    <Section
      title="What the receipt says"
      headingId="receipt"
      description="Read off the document by extraction. Confirming records that you have read it; correcting overwrites what it read."
      actions={
        <div className="flex flex-wrap gap-2">
          {!view.receipt.confirmedByUser && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Confirm it
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={openCorrection}>
            Correct it
          </Button>
        </div>
      }
    >
      <ReceiptFacts view={view} />

      <DecisionDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm this extraction"
        consequence={
          <>
            This records that a person has read the extraction and accepts it as what the document
            says. It changes no expense and no allocation — a receipt is what the shop printed, not
            what anybody owes.
          </>
        }
        confirmLabel="Confirm it"
        reasonLabel="Note for the audit trail"
        pending={confirm.isPending}
        error={confirm.error}
        onConfirm={(reason) => {
          confirm.mutate(reason === undefined ? {} : { reason }, {
            onSuccess: () => setConfirming(false),
          });
        }}
      />

      <DecisionDialog
        open={correcting}
        onClose={() => setCorrecting(false)}
        title="Correct this extraction"
        consequence={
          <>
            This overwrites what extraction read off the document. The document itself is unchanged,
            and so is any expense: correcting a receipt total is not a correction to what an expense
            cost.
          </>
        }
        confirmLabel="Save the correction"
        confirmDisabled={anyInvalid}
        reasonLabel="What the extraction got wrong"
        reasonRequired
        pending={correct.isPending}
        error={correct.error}
        onConfirm={(reason) => {
          if (reason === undefined) return;
          correct.mutate(
            {
              total: parsedTotal !== null && parsedTotal.ok ? parsedTotal.paise : null,
              subtotal: parsedSubtotal !== null && parsedSubtotal.ok ? parsedSubtotal.paise : null,
              tax: parsedTax !== null && parsedTax.ok ? parsedTax.paise : null,
              reason,
            },
            { onSuccess: () => setCorrecting(false) },
          );
        }}
      >
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receipt-total">Total</Label>
            <Input
              id="receipt-total"
              inputMode="decimal"
              value={total}
              onChange={(event) => setTotal(event.target.value)}
              className="w-36 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receipt-subtotal">Subtotal</Label>
            <Input
              id="receipt-subtotal"
              inputMode="decimal"
              value={subtotal}
              onChange={(event) => setSubtotal(event.target.value)}
              className="w-36 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receipt-tax">Tax</Label>
            <Input
              id="receipt-tax"
              inputMode="decimal"
              value={tax}
              onChange={(event) => setTax(event.target.value)}
              className="w-36 font-mono"
            />
          </div>
          <p className="text-micro text-ink-faint">
            An empty field is recorded as not stated, not as zero. The item lines are left as
            extracted; replacing them is not offered here.
          </p>
        </div>
      </DecisionDialog>
    </Section>
  );
}

/**
 * The extracted `Receipt` behind a document, with both discrepancies the service computes.
 *
 * Both are the service's own figures. A non-null `itemsSubtotalDiscrepancy` means the items
 * and the printed subtotal disagree; a non-null `paymentDiscrepancy` means the total and the
 * linked payment do. Neither is recomputed here.
 */
export function ReceiptFacts({ view }: { view: ReceiptView }) {
  const { receipt, items } = view;
  return (
    <div className="flex flex-col gap-4">
      <Facts>
        <Fact label="Total" mono>
          {receipt.total === null ? <UnknownValue /> : <Money paise={receipt.total} />}
        </Fact>
        <Fact label="Subtotal" mono>
          {receipt.subtotal === null ? <UnknownValue /> : <Money paise={receipt.subtotal} />}
        </Fact>
        <Fact label="Tax" mono>
          {receipt.tax === null ? <UnknownValue /> : <Money paise={receipt.tax} />}
        </Fact>
        <Fact label="Extraction confidence">
          {receipt.extractionConfidence === null ? (
            <UnknownValue />
          ) : (
            <Confidence level={receipt.extractionConfidence} />
          )}
        </Fact>
        <Fact label="Confirmed by you">{receipt.confirmedByUser ? "Yes" : "Not yet"}</Fact>
      </Facts>

      <NoteList
        items={[
          ...(view.itemsSubtotalDiscrepancy !== null
            ? [
                {
                  title: "The items and the printed subtotal disagree",
                  detail: (
                    <>
                      By <Money paise={view.itemsSubtotalDiscrepancy} />. The extraction is kept as
                      read; the disagreement is reported rather than corrected.
                    </>
                  ),
                },
              ]
            : []),
          ...(view.paymentDiscrepancy !== null
            ? [
                {
                  title: "The receipt total and the linked payment disagree",
                  detail: (
                    <>
                      By <Money paise={view.paymentDiscrepancy} />.
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />

      {items.length > 0 && (
        <Table className="min-w-[420px]">
          <TableCaption>Items read off this receipt</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Item</TableHead>
              <TableHead scope="col" className="text-right">
                Quantity
              </TableHead>
              <TableHead scope="col" className="text-right">
                Line total
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.description}</TableCell>
                <TableCell className="tabular text-right font-mono text-meta">
                  {item.quantity}
                </TableCell>
                <TableCell className="text-right">
                  <Money paise={item.lineTotal} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
