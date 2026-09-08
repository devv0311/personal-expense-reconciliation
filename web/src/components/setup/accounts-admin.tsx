"use client";

import { useState } from "react";
import { Section } from "@/components/page-header";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { EmptyBlock, ErrorBlock, LoadingStatus, TableSkeleton } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountTypeLabel } from "@/lib/labels";
import { useAccounts, useCreateAccount, useUpdateAccount } from "@/lib/queries";
import { ACCOUNT_TYPES, type AccountSummary, type AccountType } from "@/lib/types";

/**
 * The accounts money actually moves through — each one reconciled independently (ADR-0017).
 *
 * `last4` is the only fragment of a number this system will hold, and the service refuses
 * anything longer than four digits. That is a security boundary, not a formatting preference:
 * a full account or card number has no use here and every risk (`security-model.md`).
 */
export function AccountsAdmin() {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("bank");
  const [institution, setInstitution] = useState("");
  const [last4, setLast4] = useState("");

  const accounts = useAccounts();
  const create = useCreateAccount();
  const update = useUpdateAccount();

  const last4Valid = last4 === "" || /^[0-9]{1,4}$/.test(last4);

  return (
    <Section
      title="Accounts"
      headingId="accounts"
      description="Every account whose statement this ledger reconciles. Each closes on its own evidence; none is netted against another."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setName("");
            setType("bank");
            setInstitution("");
            setLast4("");
            create.reset();
            setAdding(true);
          }}
        >
          Add an account
        </Button>
      }
    >
      {accounts.isPending && (
        <LoadingStatus label="Loading accounts…">
          <TableSkeleton columns={3} />
        </LoadingStatus>
      )}
      {accounts.isError && (
        <ErrorBlock error={accounts.error} onRetry={() => void accounts.refetch()} />
      )}
      {accounts.isSuccess && accounts.data.length === 0 && (
        <EmptyBlock>
          No accounts yet. A statement cannot be imported until there is an account for it to belong
          to.
        </EmptyBlock>
      )}
      {accounts.isSuccess && accounts.data.length > 0 && (
        <Table className="min-w-[520px]">
          <TableCaption>Accounts</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Account</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.data.map((account) => (
              <TableRow key={account.id} className="align-top">
                <TableCell>
                  {account.name}
                  <div className="mt-0.5 text-micro text-ink-faint">
                    {account.institution ?? "No institution recorded"}
                    {account.last4 === null ? "" : ` · ••${account.last4}`}
                  </div>
                </TableCell>
                <TableCell className="text-meta">{accountTypeLabel(account.type)}</TableCell>
                <TableCell className="text-meta">
                  {account.isActive ? "Active" : "Closed"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      setName(account.name);
                      setInstitution(account.institution ?? "");
                      update.reset();
                      setEditing(account);
                    }}
                  >
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
        title="Add an account"
        consequence="This adds an account statements can be imported into and reconciled against. It records no balance — an opening balance is evidence, entered when you run a reconciliation."
        confirmLabel="Add it"
        confirmDisabled={name.trim() === "" || !last4Valid}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={() => {
          create.mutate(
            {
              name: name.trim(),
              type,
              ...(institution.trim() === "" ? {} : { institution: institution.trim() }),
              ...(last4 === "" ? {} : { last4 }),
            },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={name}
              placeholder="HDFC savings"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-type">Type</Label>
              <Select
                id="account-type"
                value={type}
                onChange={(event) => setType(event.target.value as AccountType)}
                className="w-40"
              >
                {ACCOUNT_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {accountTypeLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-institution">Institution</Label>
              <Input
                id="account-institution"
                value={institution}
                onChange={(event) => setInstitution(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-last4">Last four digits</Label>
              <Input
                id="account-last4"
                value={last4}
                inputMode="numeric"
                // Deliberately no `maxLength`: silently dropping a fifth digit would leave
                // somebody looking at four digits they did not type. Say why instead.
                onChange={(event) => setLast4(event.target.value)}
                className="w-28 font-mono"
              />
              {!last4Valid && (
                <p className="text-meta text-attention">
                  Digits only, and at most four. A full number is never stored here.
                </p>
              )}
            </div>
          </div>
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === null ? "Edit" : `Edit ${editing.name}`}
        consequence={
          <>
            This renames the account from here on. Closing it stops it being offered for new
            imports; every movement already recorded against it stays exactly as it is, and it still
            reconciles for past periods.
          </>
        }
        confirmLabel="Save"
        confirmDisabled={name.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={update.isPending}
        error={update.error}
        onConfirm={() => {
          if (editing === null) return;
          update.mutate(
            {
              accountId: editing.id,
              name: name.trim(),
              institution: institution.trim() === "" ? null : institution.trim(),
            },
            { onSuccess: () => setEditing(null) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-account-name">Name</Label>
            <Input
              id="edit-account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-account-institution">Institution</Label>
            <Input
              id="edit-account-institution"
              value={institution}
              onChange={(event) => setInstitution(event.target.value)}
            />
          </div>
          {editing !== null && (
            <Button
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                update.mutate(
                  { accountId: editing.id, isActive: !editing.isActive },
                  { onSuccess: () => setEditing(null) },
                );
              }}
            >
              {editing.isActive ? "Close this account" : "Reopen this account"}
            </Button>
          )}
        </div>
      </DecisionDialog>
    </Section>
  );
}
