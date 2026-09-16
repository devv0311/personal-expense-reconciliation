"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatDateTime } from "@/lib/dates";
import { useAccounts, useImportStatement } from "@/lib/queries";
import type { ImportStatementResult } from "@/lib/types";

const MAX_STATEMENT_BYTES = 25 * 1024 * 1024;
const ACCEPTED_STATEMENT_FILES =
  ".csv,.xlsx,.pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf";

interface SelectedStatement {
  readonly name: string;
  readonly contentBase64: string;
}

/**
 * Loads one statement in its original CSV, XLSX or PDF container.
 *
 * Two properties are worth stating on the screen rather than only in the parser, because both
 * change what a person should do next:
 *
 * - **All-or-nothing.** A file with any unreadable row imports nothing and names the bad rows.
 *   A partially imported statement leaves the ledger quietly missing movements, which is the
 *   exact condition cash reconciliation exists to detect.
 * - **A re-import is a recognised no-op**, not a second copy: the file's content hash is
 *   matched against what is already on record (`invariants.md` #10).
 *
 * The file is read in the browser and posted as base64 bytes to the local API; nothing about it
 * leaves this machine. Bytes matter: decoding a PDF or XLSX as text would corrupt it before the
 * statement parser saw it.
 */
export function ImportStatementForm() {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [statement, setStatement] = useState<SelectedStatement | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportStatementResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const accounts = useAccounts();
  const runImport = useImportStatement();

  const ready = accountId !== "" && sourceSystem.trim().length > 0 && statement !== null;

  const close = () => {
    setOpen(false);
    runImport.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={() => setOpen(true)}>Import a statement</Button>

      <DecisionDialog
        open={open}
        onClose={close}
        title="Import a bank statement"
        consequence={
          <>
            This writes every row in the file into the ledger as a payment, in one batch. Rows that
            restate a movement already on record are still written — the ledger did receive that
            evidence twice — but are marked <strong>ignored</strong> so no total counts them twice.
            If any row cannot be read, nothing at all is imported.
          </>
        }
        confirmLabel="Import it"
        confirmDisabled={!ready}
        pending={runImport.isPending}
        error={runImport.error}
        onConfirm={() => {
          if (statement === null) return;
          runImport.mutate(
            {
              accountId,
              sourceSystem: sourceSystem.trim(),
              formatId: "auto",
              contentBase64: statement.contentBase64,
              filename: statement.name,
              fileReference: statement.name,
            },
            {
              onSuccess: (imported) => {
                setResult(imported);
                setStatement(null);
                if (fileInput.current !== null) fileInput.current.value = "";
                close();
              },
            },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-account">Account this statement belongs to</Label>
            <Select
              id="import-account"
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
                No accounts exist yet. Add one in <Link href="/setup">Setup</Link> first.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-source">Where it came from</Label>
            <Input
              id="import-source"
              value={sourceSystem}
              placeholder="hdfc-savings-export"
              onChange={(event) => setSourceSystem(event.target.value)}
            />
            <p className="text-micro text-ink-faint">
              Recorded against every row as its source system, so a movement can always be traced
              back to the file it arrived in.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-file">Statement file</Label>
            <input
              ref={fileInput}
              id="import-file"
              type="file"
              accept={ACCEPTED_STATEMENT_FILES}
              className="text-body text-ink file:mr-3 file:rounded-sm file:border file:border-rule file:bg-panel file:px-3 file:py-1.5 file:text-meta file:text-ink"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setReadError(null);
                if (file === undefined) {
                  setStatement(null);
                  return;
                }
                if (file.size > MAX_STATEMENT_BYTES) {
                  setStatement(null);
                  setReadError("That statement is larger than the 25 MB local import limit.");
                  return;
                }
                readFileAsBase64(file)
                  .then((contentBase64) => setStatement({ name: file.name, contentBase64 }))
                  .catch(() => {
                    setStatement(null);
                    setReadError("That file could not be read. Try exporting it again.");
                  });
              }}
            />
            <p className="text-micro text-ink-faint">
              CSV, XLSX or PDF. The local API detects supported bank and card layouts from the
              file itself; an unknown layout is refused without importing a partial statement.
            </p>
            {readError !== null && <p className="text-meta text-debit">{readError}</p>}
          </div>
        </div>
      </DecisionDialog>

      {result !== null && <ImportOutcome result={result} />}
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The file reader returned no data."));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (comma === -1) {
        reject(new Error("The file reader returned an invalid data URL."));
        return;
      }
      resolve(reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function ImportOutcome({ result }: { result: ImportStatementResult }) {
  if (result.outcome === "already_imported") {
    return (
      <Alert variant="attention">
        <AlertTitle>This file was already imported</AlertTitle>
        <AlertDescription>
          <p>
            Its contents match a batch loaded on {formatDateTime(result.previouslyImportedAt)}.
            Nothing was written a second time.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const imported = result.paymentIds.length;
  return (
    <Alert variant="attention">
      <AlertTitle>
        Imported {imported} row{imported === 1 ? "" : "s"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {result.duplicates.length === 0
            ? "No row restated a movement already on record."
            : `${result.duplicates.length} row${
                result.duplicates.length === 1 ? "" : "s"
              } restated a movement already on record. Each was kept for provenance and marked ignored, so nothing is counted twice.`}
        </p>
        <p>
          They are unexplained until something explains them. Run normalization next, then
          classification.
        </p>
      </AlertDescription>
    </Alert>
  );
}
