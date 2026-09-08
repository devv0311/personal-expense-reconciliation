"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDate, fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useAssignOccasion, useCreateOccasion, useOccasions } from "@/lib/queries";

/**
 * Occasions: the dinner, the dessert and the cab home, grouped as one evening.
 *
 * A label, and nothing more. Filing an expense under an occasion moves no figure, creates no
 * obligation and changes no allocation — which is exactly why it is safe to do liberally. It
 * groups, it does not merge: three expenses under one occasion are still three expenses with
 * their own beneficiaries and their own shares.
 */
export function OccasionList() {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [start, setStart] = useState(toDateInputValue(new Date()));
  const [end, setEnd] = useState("");

  const occasions = useOccasions();
  const create = useCreateOccasion();

  return (
    <Section
      title="Occasions"
      headingId="occasions"
      description="A night out, a trip. Grouping expenses under one carries no money — it is a label on top of the ledger, not a change to it."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setName("");
            create.reset();
            setAdding(true);
          }}
        >
          Add an occasion
        </Button>
      }
    >
      {occasions.isPending && (
        <LoadingStatus label="Loading occasions…">
          <TableSkeleton columns={2} rows={2} />
        </LoadingStatus>
      )}
      {occasions.isError && (
        <ErrorBlock error={occasions.error} onRetry={() => void occasions.refetch()} />
      )}
      {occasions.isSuccess && occasions.data.length === 0 && (
        <EmptyBlock>No occasions yet. Expenses stand on their own, which is fine.</EmptyBlock>
      )}
      {occasions.isSuccess && occasions.data.length > 0 && (
        <ul className="flex flex-col">
          {occasions.data.map((occasion) => (
            <li
              key={occasion.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-2.5 last:border-b-0"
            >
              <span className="text-body text-ink">
                {occasion.name}
                <span className="block text-meta text-ink-muted">
                  {formatDate(occasion.occurredStart)}
                  {occasion.occurredEnd === null ? "" : ` – ${formatDate(occasion.occurredEnd)}`}
                </span>
              </span>
              <span className="text-meta text-ink-muted">
                {occasion.expenseCount} {occasion.expenseCount === 1 ? "expense" : "expenses"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <DecisionDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add an occasion"
        consequence="This creates a label expenses can be filed under. It carries no money and creates no obligation."
        confirmLabel="Add it"
        confirmDisabled={name.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={() => {
          create.mutate(
            {
              name: name.trim(),
              occurredStart: fromDateInputValue(start),
              ...(end === "" ? {} : { occurredEnd: fromDateInputValue(end) }),
            },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="occasion-name">Name</Label>
            <Input
              id="occasion-name"
              value={name}
              placeholder="Anjali's birthday"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="occasion-start">From</Label>
              <Input
                id="occasion-start"
                type="date"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="occasion-end">To</Label>
              <Input
                id="occasion-end"
                type="date"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
              <p className="text-micro text-ink-faint">Optional — a trip spans days.</p>
            </div>
          </div>
        </div>
      </DecisionDialog>
    </Section>
  );
}

/** Files one expense under an occasion, or takes it out of one. Never moves a figure. */
export function OccasionPicker({ expenseId }: { expenseId: string }) {
  const occasions = useOccasions();
  const assign = useAssignOccasion(expenseId);
  const [chosen, setChosen] = useState("");

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="expense-occasion">Occasion</Label>
        <Select
          id="expense-occasion"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          className="min-w-[200px]"
        >
          <option value="">Not filed under one</option>
          {(occasions.data ?? []).map((occasion) => (
            <option key={occasion.id} value={occasion.id}>
              {occasion.name}
            </option>
          ))}
        </Select>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={assign.isPending}
        onClick={() => assign.mutate(chosen === "" ? null : chosen)}
      >
        {assign.isPending ? "Filing…" : "File it"}
      </Button>
      {assign.isError && <ErrorBlock error={assign.error} />}
    </div>
  );
}
