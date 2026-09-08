"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
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
import { useCreatePerson, usePeopleManagement, useUpdatePerson } from "@/lib/queries";
import type { PersonDetail } from "@/lib/types";

/**
 * Everyone this ledger can owe or be owed by.
 *
 * Archiving is the only removal offered, and deliberately: a person who appears in a past
 * allocation is part of that expense's history forever, so deleting them would falsify records
 * that are supposed to be immutable. An archived person stops being offered in new pickers and
 * keeps every figure they are already part of.
 *
 * The Splitwise id is stored here rather than guessed at sync time — matching people by display
 * name across two systems is how the wrong person ends up owing money.
 */
export function PeopleAdmin() {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PersonDetail | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [splitwiseUserId, setSplitwiseUserId] = useState("");
  const [notes, setNotes] = useState("");

  const people = usePeopleManagement();
  const create = useCreatePerson();
  const update = useUpdatePerson();

  const openAdd = () => {
    setDisplayName("");
    setSplitwiseUserId("");
    setNotes("");
    create.reset();
    setAdding(true);
  };

  const openEdit = (person: PersonDetail) => {
    setDisplayName(person.displayName);
    setSplitwiseUserId(person.splitwiseUserId ?? "");
    setNotes(person.notes ?? "");
    update.reset();
    setEditing(person);
  };

  return (
    <Section
      title="People"
      headingId="people"
      description="Who money moves between. One of them is you; the rest are the counterparties every balance is computed against."
      actions={
        <Button variant="outline" size="sm" onClick={openAdd}>
          Add a person
        </Button>
      }
    >
      {people.isPending && (
        <LoadingStatus label="Loading people…">
          <TableSkeleton columns={3} />
        </LoadingStatus>
      )}
      {people.isError && <ErrorBlock error={people.error} onRetry={() => void people.refetch()} />}
      {people.isSuccess && people.data.length === 0 && (
        <EmptyBlock>
          Nobody has been added yet. The ledger needs at least you before it can say who owes whom.
        </EmptyBlock>
      )}
      {people.isSuccess && people.data.length > 0 && (
        <Table className="min-w-[520px]">
          <TableCaption>People in this ledger</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Splitwise</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.data.map((person) => (
              <TableRow key={person.id} className="align-top">
                <TableCell>
                  {person.displayName}
                  {person.isUser && <span className="ml-1.5 text-micro text-accent">you</span>}
                  {person.notes !== null && (
                    <div className="mt-0.5 text-micro text-ink-faint">{person.notes}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-meta">
                  {person.splitwiseUserId ?? (
                    <span className="text-ink-faint italic">Not mapped</span>
                  )}
                </TableCell>
                <TableCell className="text-meta">
                  {person.archivedAt === null ? "Active" : "Archived"}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="link" size="sm" onClick={() => openEdit(person)}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <DecisionDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a person"
        consequence="This adds someone the ledger can compute a balance with. It creates no expense, no obligation and no payment."
        confirmLabel="Add them"
        confirmDisabled={displayName.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={() => {
          create.mutate(
            {
              displayName: displayName.trim(),
              ...(splitwiseUserId.trim() === "" ? {} : { splitwiseUserId: splitwiseUserId.trim() }),
              ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
            },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <PersonFields
          displayName={displayName}
          splitwiseUserId={splitwiseUserId}
          notes={notes}
          onDisplayName={setDisplayName}
          onSplitwiseUserId={setSplitwiseUserId}
          onNotes={setNotes}
        />
      </DecisionDialog>

      <DecisionDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === null ? "Edit" : `Edit ${editing.displayName}`}
        consequence={
          <>
            This changes how they are named and matched from here on. Every figure they are already
            part of is unchanged — a rename is not a correction to a past expense.
            {editing?.archivedAt === null && " Archiving stops them being offered in new pickers."}
          </>
        }
        confirmLabel="Save"
        confirmDisabled={displayName.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={update.isPending}
        error={update.error}
        onConfirm={() => {
          if (editing === null) return;
          update.mutate(
            {
              personId: editing.id,
              displayName: displayName.trim(),
              splitwiseUserId: splitwiseUserId.trim() === "" ? null : splitwiseUserId.trim(),
              notes: notes.trim() === "" ? null : notes.trim(),
            },
            { onSuccess: () => setEditing(null) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <PersonFields
            displayName={displayName}
            splitwiseUserId={splitwiseUserId}
            notes={notes}
            onDisplayName={setDisplayName}
            onSplitwiseUserId={setSplitwiseUserId}
            onNotes={setNotes}
          />
          {editing !== null && !editing.isUser && (
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                update.mutate(
                  { personId: editing.id, archived: editing.archivedAt === null },
                  { onSuccess: () => setEditing(null) },
                );
              }}
            >
              {editing.archivedAt === null ? "Archive this person" : "Restore this person"}
            </Button>
          )}
        </div>
      </DecisionDialog>
    </Section>
  );
}

function PersonFields({
  displayName,
  splitwiseUserId,
  notes,
  onDisplayName,
  onSplitwiseUserId,
  onNotes,
}: {
  displayName: string;
  splitwiseUserId: string;
  notes: string;
  onDisplayName: (value: string) => void;
  onSplitwiseUserId: (value: string) => void;
  onNotes: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="person-name">Name</Label>
        <Input
          id="person-name"
          value={displayName}
          onChange={(event) => onDisplayName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="person-splitwise">Splitwise user id</Label>
        <Input
          id="person-splitwise"
          value={splitwiseUserId}
          placeholder="Optional"
          onChange={(event) => onSplitwiseUserId(event.target.value)}
          className="font-mono text-meta"
        />
        <p className="text-micro text-ink-faint">
          Used to match this person when auditing Splitwise. Without it, their side of a shared
          expense cannot be compared.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="person-notes">Notes</Label>
        <Input id="person-notes" value={notes} onChange={(event) => onNotes(event.target.value)} />
      </div>
    </div>
  );
}
