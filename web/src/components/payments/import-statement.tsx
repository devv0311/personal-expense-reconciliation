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
import type { MultiFormatImportResult, StatementImportWarning } from "@/lib/types";

/**
 * The largest statement this screen will read into memory and post as base64.
 *
 * Base64 inflates a file by roughly a third, so the request body is the number that matters
 * rather than the file's own size. A personal statement is a few hundred kilobytes; this bound
 * exists so a mis-selected file fails here, with a sentence, instead of as a stalled upload.
 */
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
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<MultiFormatImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Which file selection the component is currently reading.
   *
   * A `FileReader` finishes when it finishes, so picking a large file and then a small one can
   * land the *first* read last — and the staged statement would then be the file the person
   * had already replaced, imported under the name of the one they chose. Every selection takes
   * the next number and only the holder of the current one is allowed to write state; closing
   * or clearing takes a number nobody holds, which abandons whatever is still in flight.
   */
  const readGeneration = useRef(0);

  const accounts = useAccounts();
  const runImport = useImportStatement();

  const ready =
    accountId !== "" && sourceSystem.trim().length > 0 && statement !== null && !reading;

  const clearFileInput = () => {
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  /** Abandons any read still in flight, and returns the generation this caller owns. */
  const beginRead = () => {
    readGeneration.current += 1;
    return readGeneration.current;
  };

  const close = () => {
    // A read that resolves after the dialog closed must not stage a file behind it.
    beginRead();
    setReading(false);
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
                clearFileInput();
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
                const generation = beginRead();
                const isCurrent = () => readGeneration.current === generation;

                setReadError(null);
                setStatement(null);
                if (file === undefined) {
                  setReading(false);
                  return;
                }
                if (file.size > MAX_STATEMENT_BYTES) {
                  setReading(false);
                  clearFileInput();
                  setReadError("That statement is larger than the 25 MB local import limit.");
                  return;
                }
                setReading(true);
                readFileAsBase64(file)
                  .then((contentBase64) => {
                    if (!isCurrent()) return;
                    setStatement({ name: file.name, contentBase64 });
                  })
                  .catch(() => {
                    if (!isCurrent()) return;
                    clearFileInput();
                    setReadError("That file could not be read. Try exporting it again.");
                  })
                  .finally(() => {
                    // A superseded read must not clear the state of the one that replaced it.
                    if (isCurrent()) setReading(false);
                  });
              }}
            />
            <p className="text-micro text-ink-faint">
              CSV, XLSX or PDF, exactly as the bank produced it. The file is read on this machine
              and its layout detected from the file itself; a layout this build does not read is
              refused rather than imported in part.
            </p>
            {reading && (
              <p className="text-meta text-ink-faint" role="status">
                Reading the file…
              </p>
            )}
            {readError !== null && (
              <p className="text-meta text-debit" role="alert">
                {readError}
              </p>
            )}
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

function ImportOutcome({ result }: { result: MultiFormatImportResult }) {
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
    <div className="flex flex-col gap-3">
      <Alert variant="attention">
        <AlertTitle>
          Imported {imported} row{imported === 1 ? "" : "s"}
        </AlertTitle>
        <AlertDescription>
          <p>
            Read with the <span className="font-mono">{result.formatId}</span> layout.
          </p>
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
      <ImportWarnings warnings={result.warnings} />
    </div>
  );
}

/**
 * What the reader could not read, said on the screen rather than only in the response.
 *
 * A PDF has no columns, so the count a reader returns is how many movements it *matched* — not
 * how many the statement printed. Leaving that in the API and rendering only the count would
 * turn a partial read into a confident one, which is the exact silence the unexplained-money
 * pillar exists to break. The warnings are quoted verbatim; nothing here recomputes or judges
 * them.
 */
function ImportWarnings({ warnings }: { warnings: readonly StatementImportWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="attention">
      <AlertTitle>Check this against the statement itself</AlertTitle>
      <AlertDescription>
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {warnings.map((warning, index) => (
            <li key={`${warning.lineNumber ?? "file"}-${index}`}>{warning.message}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
