"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { PreparedResult } from "@/components/analysis/prepared-result";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Money } from "@/components/money";
import { formatDate, formatDateTime } from "@/lib/dates";
import { useAccounts, useImportStatement, usePreviewStatement } from "@/lib/queries";
import type {
  AccountSummary,
  AccountType,
  MultiFormatImportResult,
  StatementImportWarning,
  StatementLayoutChoice,
  StatementPreview,
} from "@/lib/types";

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
 * The kinds of account a statement can be from — the same five an account can be in Setup — in
 * the order a person holding one thinks of them.
 */
const STATEMENT_KINDS: readonly AccountType[] = ["bank", "card", "upi", "wallet", "cash"];

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
export function ImportStatementForm({ triggerLabel }: { triggerLabel?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  /**
   * What the person says the chosen file is a statement of, when the file does not say (ADR-0068).
   *
   * Never filled in on anybody's behalf — not from the accounts on file, not from the file's
   * columns, and not from an account chosen earlier — and cleared with every new file, because
   * it was an answer about the last one.
   */
  const [statedKind, setStatedKind] = useState<AccountType | "">("");
  const [statement, setStatement] = useState<SelectedStatement | null>(null);
  /**
   * The layouts a file's columns fit equally well, when detection could not choose (ADR-0068's
   * neighbour: a layout is how columns are arranged, never whose statement it is).
   *
   * Only ever what the API reported for **this** file, so the choices cannot go stale: a new file
   * clears them with everything else read from the last one.
   */
  const [layoutChoices, setLayoutChoices] = useState<readonly StatementLayoutChoice[] | null>(null);
  /** The layout the person picked. Empty until they do; never filled in on their behalf. */
  const [layoutId, setLayoutId] = useState("");
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
  /**
   * What the chosen file is, read by the API before anything is imported (ADR-0066).
   *
   * Advisory, deliberately: if the reading cannot be reached, the import still reads the file
   * itself and refuses it whole if it cannot, and the API still refuses a statement written onto
   * the wrong kind of account. What the reading adds is the chance to say so *before* anybody
   * chooses an account or confirms anything. A file it read and could not import is the one
   * case where it blocks, because importing it would only be refused.
   */
  const preview = usePreviewStatement();
  // An API that predates the reading answers with something that is not one (or with a 404,
  // which is `isError`); either way the reading is simply unavailable, never "unreadable".
  const readingUnavailable = preview.isError || (preview.isSuccess && !isReading(preview.data));
  const statementReading = preview.isSuccess && isReading(preview.data) ? preview.data : null;
  /** The kind of account the document itself says it belongs to — a PDF that names it. */
  const documentKind =
    statementReading !== null && statementReading.readable ? statementReading.accountKind : null;
  /**
   * Whether the person has to say what the file is a statement of (ADR-0068).
   *
   * Asked once the file has been read and says nothing about it — every CSV and spreadsheet, whose
   * columns look the same for a bank account and a card — and when the file could not be read
   * ahead of the import, because nothing then says what it is. Not asked while the file is being
   * read, nor about a file that cannot be imported at all.
   */
  const asksKind =
    statement !== null &&
    !preview.isPending &&
    documentKind === null &&
    (readingUnavailable || statementReading?.readable === true);
  /** The kind the account is checked against: the document's own word, else the person's. */
  const accountKind = documentKind ?? (asksKind && statedKind !== "" ? statedKind : null);
  const kindNamedBy = documentKind !== null ? "document" : "person";
  const chosenAccount = (accounts.data ?? []).find((account) => account.id === accountId);
  // Until the question is answered nothing fits, so an account picked first is never enough.
  const accountFits =
    accountKind === null
      ? !asksKind
      : chosenAccount !== undefined && chosenAccount.type === accountKind;
  const readingAllows = readingUnavailable || statementReading?.readable === true;
  /** Detection could not choose and the person has not yet: nothing can be read until they do. */
  const awaitingLayout = layoutChoices !== null && layoutId === "";

  const ready =
    !awaitingLayout &&
    accountId !== "" &&
    sourceSystem.trim().length > 0 &&
    statement !== null &&
    !reading &&
    readingAllows &&
    accountFits;

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
    setStatedKind("");
    setLayoutChoices(null);
    setLayoutId("");
    setOpen(false);
    runImport.reset();
    preview.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={() => setOpen(true)}>{triggerLabel ?? "Import a statement"}</Button>

      <DecisionDialog
        open={open}
        onClose={close}
        title="Import a statement"
        consequence={
          <>
            This writes every row in the file into the ledger as a payment on the account chosen
            below, in one batch. Rows that restate a movement already on record are still written —
            the ledger did receive that evidence twice — but are marked <strong>ignored</strong> so
            no total counts them twice. If any row cannot be read, nothing at all is imported.
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
              // Exactly the layout the person chose when detection could not, else detection.
              formatId: layoutId !== "" ? layoutId : "auto",
              contentBase64: statement.contentBase64,
              filename: statement.name,
              fileReference: statement.name,
              // Only the person's own answer, and only when the file did not say for itself.
              statementKind: documentKind === null && statedKind !== "" ? statedKind : undefined,
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
                setStatedKind("");
                // Everything read from the last file, and every answer about it, goes with it.
                setLayoutChoices(null);
                setLayoutId("");
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
                preview.reset();
                readFileAsBase64(file)
                  .then((contentBase64) => {
                    if (!isCurrent()) return;
                    setStatement({ name: file.name, contentBase64 });
                    preview.mutate(
                      { contentBase64, filename: file.name },
                      {
                        onSuccess: (data) => {
                          if (!isCurrent()) return;
                          if (isReading(data) && !data.readable && data.ambiguousLayouts) {
                            setLayoutChoices(data.ambiguousLayouts);
                          }
                        },
                      },
                    );
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
              and its layout detected from the file itself — or, when its columns fit more than one
              layout, chosen by you; a layout this build does not read is refused rather than
              imported in part.
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

          {layoutChoices !== null && (
            <LayoutChoiceGroup
              choices={layoutChoices}
              chosen={layoutId}
              disabled={statement === null || reading}
              onChoose={(id) => {
                if (statement === null) return;
                // Reading again with this layout, from the same original bytes. The earlier
                // reading is dropped first so no figure from another layout is on screen while
                // this one is being read.
                // The answer about whose statement this is stays: it was about the file, which
                // has not changed — only how its columns are read.
                setLayoutId(id);
                preview.reset();
                preview.mutate({
                  contentBase64: statement.contentBase64,
                  filename: statement.name,
                  formatId: id,
                });
              }}
            />
          )}

          {!awaitingLayout && (
            <StatementReading
              pending={preview.isPending}
              failed={readingUnavailable}
              reading={statementReading}
              canChooseAnother={layoutChoices !== null}
            />
          )}

          {asksKind && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-kind">What kind of account is this statement from?</Label>
              <Select
                id="import-kind"
                value={statedKind}
                onChange={(event) => setStatedKind(event.target.value as AccountType | "")}
              >
                <option value="">Choose one…</option>
                {STATEMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {capitalise(accountWords(kind))}
                  </option>
                ))}
              </Select>
              <p className="max-w-prose text-micro text-ink-faint">
                {readingUnavailable
                  ? "The file couldn’t be read ahead of the import, so nothing yet says whose statement it is. The answer is yours, and the import is checked against it."
                  : "The file doesn’t say — a CSV or spreadsheet looks the same whether it came from a bank account or a card — so the answer is yours. Only an account of that kind can take it."}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-account">Account this statement belongs to</Label>
            <Select
              id="import-account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Choose an account…</option>
              {(accounts.data ?? []).map((account) => {
                const fits = accountKind === null || account.type === accountKind;
                return (
                  <option key={account.id} value={account.id} disabled={!fits}>
                    {account.name}
                    {account.last4 === null ? "" : ` ••${account.last4}`}
                    {fits ? "" : ` — not ${accountWords(accountKind)}`}
                  </option>
                );
              })}
            </Select>
            {accounts.isSuccess && accounts.data.length === 0 && accountKind === null && (
              <p className="text-meta text-attention">
                No accounts exist yet. Add one in <SetupLink /> first.
              </p>
            )}
            <AccountBoundary
              accountKind={accountKind}
              namedBy={kindNamedBy}
              accounts={accounts.isSuccess ? accounts.data : null}
              chosen={chosenAccount}
            />
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

          {statementReading !== null && statementReading.readable && (
            <ImportSummary
              layoutLabel={statementReading.formatLabel}
              kind={accountKind}
              kindNamedBy={kindNamedBy}
              account={chosenAccount}
            />
          )}
        </div>
      </DecisionDialog>

      {result !== null && <ImportOutcome result={result} />}
    </div>
  );
}

/**
 * Which layout reads a file whose columns fit more than one — a question, never a recommendation.
 *
 * Every option is a layout the API found fitting this very file, so nothing unsupported can be
 * chosen, and none is checked until the person picks one. It says in words why the question
 * exists (the layouts read some rows differently) and that the answer is not a kind of account:
 * a layout is how the columns are arranged, which is why the account question stays separate.
 */
function LayoutChoiceGroup({
  choices,
  chosen,
  disabled,
  onChoose,
}: {
  choices: readonly StatementLayoutChoice[];
  chosen: string;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const idBase = useId();
  return (
    <fieldset
      // A fieldset is as wide as its widest content unless told otherwise, and a header line
      // is one long unbroken string: without `min-w-0` it widens the whole dialog on a phone.
      className="flex min-w-0 flex-col gap-2 rounded-sm border border-rule p-4"
      disabled={disabled}
    >
      <legend className="px-1 text-body font-medium text-ink">How should this file be read?</legend>
      <p className="max-w-prose text-meta text-ink-muted">
        This file’s columns fit more than one layout, and the layouts read some rows differently —
        for instance which way money went — so none was chosen for you. Pick the one that matches
        the statement, then check the totals below against it. A layout says how the columns are
        arranged; it does not say what kind of account the file is from.
      </p>
      <ul className="flex flex-col gap-2">
        {choices.map((choice) => (
          <li key={choice.id}>
            <label
              className={
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-sm border px-3 py-2 " +
                (chosen === choice.id ? "border-accent bg-accent-bg" : "border-rule")
              }
            >
              <input
                type="radio"
                name="statement-layout"
                value={choice.id}
                checked={chosen === choice.id}
                onChange={() => onChoose(choice.id)}
                // Named by the words on screen, never by the layout's internal id.
                aria-labelledby={`${idBase}-${choice.id}-label`}
                aria-describedby={`${idBase}-${choice.id}-hint`}
                className="mt-1 size-4 shrink-0"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span id={`${idBase}-${choice.id}-label`} className="text-body text-ink">
                  {choice.label}
                </span>
                <span
                  id={`${idBase}-${choice.id}-hint`}
                  className="break-all font-mono text-micro text-ink-muted"
                >
                  {choice.headerHint}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * What importing will do, in one place, before the button that does it.
 *
 * The layout read, whose statement the file is and who said so, and the account it goes into —
 * all of them already on the screen above, gathered so that a person confirming sees the whole
 * decision rather than assembling it. Nothing is computed here, and an unanswered line says it
 * is unanswered instead of reading as settled.
 */
function ImportSummary({
  layoutLabel,
  kind,
  kindNamedBy,
  account,
}: {
  layoutLabel: string;
  kind: string | null;
  kindNamedBy: "document" | "person";
  account: AccountSummary | undefined;
}) {
  return (
    <section
      aria-label="What importing will do"
      className="flex flex-col gap-1 rounded-sm bg-panel p-4 text-meta"
    >
      <p className="font-medium text-ink">What importing will do</p>
      <dl className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-faint">Read as</dt>
          <dd className="text-ink">{layoutLabel}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-faint">A statement of</dt>
          <dd className="text-ink">
            {kind === null
              ? "not answered yet"
              : `${accountWords(kind)} — ${kindNamedBy === "document" ? "named by the document" : "said by you"}`}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-faint">Goes into</dt>
          <dd className="text-ink">
            {account === undefined
              ? "not chosen yet"
              : `${account.name}${account.last4 === null ? "" : ` ••${account.last4}`}`}
          </dd>
        </div>
      </dl>
    </section>
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
            Its contents match one you added on {formatDateTime(result.previouslyImportedAt)}.
            Nothing was written a second time, so nothing has changed.
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
          {/*
            The layout the reader matched is provenance — recorded on the batch, and shown in
            the import history under More. It was the first thing this alert said, on a screen
            a person reaches while holding a bank statement, and it is not something they can
            do anything with.
          */}
          <p>
            {result.duplicates.length === 0
              ? "No row restated a movement already on record."
              : `${result.duplicates.length} row${
                  result.duplicates.length === 1 ? "" : "s"
                } restated a movement already on record. Each was kept for provenance and marked ignored, so nothing is counted twice.`}
          </p>
        </AlertDescription>
      </Alert>
      <ImportWarnings warnings={result.warnings} />
      {/*
        What used to be a button here, then a button on another screen before that. The import
        reads its own rows in the same request, so this reports what came of it rather than
        asking for permission to look.
      */}
      {/*
        Read defensively: an API that has not been restarted since this shipped sends no
        `prepared` at all, and a blank screen after a successful import — the one moment a
        person most needs to be told what happened — is a worse failure than saying nothing
        about the reading.
      */}
      {result.prepared === undefined ? null : result.prepared.ran ? (
        <PreparedResult result={result.prepared.analysis} />
      ) : (
        <p className="max-w-prose text-meta text-ink-muted">{result.prepared.reason}</p>
      )}
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

/**
 * What the chosen file is and what is on it, before anybody decides where it goes.
 *
 * Every figure is one the API computed; this only formats them. A file the reader could not
 * read says so here, with the reader's own reason, because an import would only be refused.
 */
function StatementReading({
  pending,
  failed,
  reading,
  canChooseAnother,
}: {
  pending: boolean;
  failed: boolean;
  reading: StatementPreview | null;
  /** A layout was chosen for this file, so a refusal is that layout's and another may fit. */
  canChooseAnother: boolean;
}) {
  if (pending) {
    return (
      <p className="text-meta text-ink-faint" role="status">
        Reading the statement…
      </p>
    );
  }
  if (failed) {
    return (
      <p className="max-w-prose text-meta text-ink-muted" role="status">
        The file could not be read ahead of the import. Importing it reads it again, and writes
        nothing unless every row can be read.
      </p>
    );
  }
  if (reading === null) return null;

  if (!reading.readable) {
    const [first, ...rest] = reading.problems;
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>This file can’t be imported</AlertTitle>
        <AlertDescription>
          {first !== undefined && <p>{first.message}</p>}
          {canChooseAnother && (
            <p className="mt-1 text-meta">
              That is how this layout reads the file. You can choose a different layout above.
            </p>
          )}
          {rest.length > 0 && (
            <p className="mt-1 text-meta">
              {rest.length === 1 ? "One more line" : `${rest.length} more lines`} could not be read
              either. Nothing has been written.
            </p>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule p-4" role="status">
      <p className="text-body font-medium text-ink">{reading.formatLabel}</p>
      <p className="text-meta text-ink-muted">
        {reading.movementCount === 1 ? "1 movement" : `${reading.movementCount} movements`}
        {reading.firstDate !== null && reading.lastDate !== null && (
          <>
            , {formatDate(reading.firstDate)} to {formatDate(reading.lastDate)}
          </>
        )}
      </p>
      <dl className="flex flex-wrap gap-x-8 gap-y-1 text-meta">
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-faint">Money out ({reading.debitCount})</dt>
          <dd>
            <Money paise={reading.totalDebits} tone="debit" />
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ink-faint">Money in ({reading.creditCount})</dt>
          <dd>
            <Money paise={reading.totalCredits} tone="credit" />
          </dd>
        </div>
        {reading.closingBalance !== null && (
          <div className="flex items-baseline gap-2">
            <dt className="text-ink-faint">Closing balance printed</dt>
            <dd>
              <Money paise={reading.closingBalance} />
            </dd>
          </div>
        )}
      </dl>
      {reading.checksPrintedBalances && (
        <p className="text-meta text-ink-muted">
          Every movement is accounted for by the balances the statement printed, day by day.
        </p>
      )}
      {reading.warnings.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-meta text-ink-muted">
          {reading.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {reading.alreadyImported !== null && (
        <p className="text-meta text-attention">
          This exact file is already on record, from an import on{" "}
          {formatDateTime(reading.alreadyImported.importedAt)}. Importing it again changes nothing.
        </p>
      )}
    </div>
  );
}

/**
 * The line this screen will not cross for anybody: which account a statement belongs to.
 *
 * A statement can only go into an account of the kind it is a statement of — a bank statement
 * into a bank account, a card statement into a card. The kind is the document's own word when it
 * names one (ADR-0066, ADR-0067) and the person's answer when it does not (ADR-0068), and each
 * sentence says which, so nobody is told a CSV "is" something it never said. When no account of
 * that kind exists, adding one is the person's own decision — its name is theirs to choose — so
 * this says so and points at Setup rather than inventing one.
 */
function AccountBoundary({
  accountKind,
  namedBy,
  accounts,
  chosen,
}: {
  accountKind: string | null;
  namedBy: "document" | "person";
  accounts: readonly AccountSummary[] | null;
  chosen: AccountSummary | undefined;
}) {
  if (accountKind === null || accounts === null) return null;
  const fitting = accounts.filter((account) => account.type === accountKind);
  if (fitting.length === 0) {
    const what =
      namedBy === "document"
        ? `This is ${statementWords(accountKind)}`
        : `You said this is ${statementWords(accountKind)}`;
    return (
      <p className="max-w-prose text-meta text-attention" role="alert">
        {what}, and there is no {accountNoun(accountKind)} on record yet. Add the{" "}
        {accountNoun(accountKind)} in <SetupLink /> — its name is yours to choose — then come back
        to import this file. Nothing has been imported.
      </p>
    );
  }
  if (chosen !== undefined && chosen.type !== accountKind) {
    const whose =
      namedBy === "document"
        ? `This statement belongs to ${accountWords(accountKind)}`
        : `You said this statement is from ${accountWords(accountKind)}`;
    return (
      <p className="max-w-prose text-meta text-attention" role="alert">
        {whose}, and the account chosen is {accountWords(chosen.type)}. Choose{" "}
        {accountWords(accountKind)} instead.
      </p>
    );
  }
  return null;
}

/**
 * The way to the one place an account is added. Underlined at rest (`Design.md`, "Links"): it
 * sits inside a sentence of the same colour, where colour alone could not mark it as a link.
 */
function SetupLink() {
  return (
    <Link href="/setup" className="text-accent underline underline-offset-2">
      Setup
    </Link>
  );
}

function accountWords(type: string | null): string {
  switch (type) {
    case "bank":
      return "a bank account";
    case "card":
      return "a card";
    case "upi":
      return "a UPI account";
    case "wallet":
      return "a wallet";
    case "cash":
      return "cash";
    default:
      return "another kind of account";
  }
}

function accountNoun(type: string): string {
  // "There is no cash on record yet" reads as a remark about money rather than an account.
  if (type === "cash") return "cash account";
  return accountWords(type).replace(/^an? /, "");
}

/** "a bank account" → "A bank account", for an option standing on its own. */
function capitalise(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the file is, in the words a person would use for it: "a card statement". */
function statementWords(type: string): string {
  switch (type) {
    case "bank":
      return "a bank account statement";
    case "card":
      return "a card statement";
    case "upi":
      return "a UPI account statement";
    case "wallet":
      return "a wallet statement";
    case "cash":
      return "a cash statement";
    default:
      return "a statement of another kind of account";
  }
}

/** Whether a reading response is one this screen understands. */
function isReading(value: unknown): value is StatementPreview {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly readable?: unknown }).readable === "boolean"
  );
}
