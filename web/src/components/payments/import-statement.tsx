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
import { useAccounts, useImportBankCsv } from "@/lib/queries";
import type { ImportStatementResult } from "@/lib/types";

/** What the phase-6 parser reads. Named on screen so a rejected file is a fixable file. */
const EXPECTED_COLUMNS = "date,description,amount_inr,type,reference";

/**
 * Loads one bank-statement CSV.
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
 * The file is read in the browser and posted as text; nothing about it leaves this machine.
 */
export function ImportStatementForm() {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportStatementResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const accounts = useAccounts();
  const runImport = useImportBankCsv();

  const ready = accountId !== "" && sourceSystem.trim().length > 0 && fileContent !== null;

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
          if (fileContent === null) return;
          runImport.mutate(
            {
              accountId,
              sourceSystem: sourceSystem.trim(),
              fileContent,
              ...(fileName === null ? {} : { fileReference: fileName }),
            },
            {
              onSuccess: (imported) => {
                setResult(imported);
                setFileContent(null);
                setFileName(null);
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
            <Label htmlFor="import-file">CSV file</Label>
            <input
              ref={fileInput}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              className="text-body text-ink file:mr-3 file:rounded-sm file:border file:border-rule file:bg-panel file:px-3 file:py-1.5 file:text-meta file:text-ink"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setReadError(null);
                if (file === undefined) {
                  setFileContent(null);
                  setFileName(null);
                  return;
                }
                setFileName(file.name);
                file
                  .text()
                  .then((text) => setFileContent(text))
                  .catch(() => {
                    setFileContent(null);
                    setReadError("That file could not be read. Try exporting it again.");
                  });
              }}
            />
            <p className="text-micro text-ink-faint">
              Columns: <span className="font-mono">{EXPECTED_COLUMNS}</span>. Other bank formats are
              not parsed yet — a PDF or XLSX statement cannot be imported here.
            </p>
            {readError !== null && <p className="text-meta text-debit">{readError}</p>}
          </div>
        </div>
      </DecisionDialog>

      {result !== null && <ImportOutcome result={result} />}
    </div>
  );
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
