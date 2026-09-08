"use client";

import { useState } from "react";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnectSplitwise } from "@/lib/queries";
import type { SplitwiseAuditRun } from "@/lib/types";

/**
 * Connecting the integration, and saying plainly when nothing is connected.
 *
 * The distinction this holds is ADR-0046's: **a read that never happened is not agreement.**
 * With no integration, an audit reports `skipped` and finds nothing — which looks identical to
 * "the two ledgers agree" unless a screen says otherwise. So this banner leads with the state,
 * not with the empty result.
 *
 * Connecting records configuration. It is not an audit, it syncs nothing, and it never writes to
 * Splitwise; credentials themselves live in the API process's environment, never in a browser.
 */
export function SplitwiseConnection({ latestRun }: { latestRun: SplitwiseAuditRun | undefined }) {
  const [open, setOpen] = useState(false);
  const [externalAccountRef, setExternalAccountRef] = useState("");
  const connect = useConnectSplitwise();

  const neverRead = latestRun === undefined || latestRun.externalReadStatus === "skipped";

  return (
    <>
      {neverRead && (
        <Alert variant="attention">
          <AlertTitle>Splitwise has not been read</AlertTitle>
          <AlertDescription>
            <p>
              {latestRun === undefined
                ? "No audit has run yet."
                : "The last audit could not read Splitwise at all, so it found nothing — which is not the same as finding agreement."}{" "}
              Connect the integration, and make sure each person&apos;s Splitwise id is filled in
              under Setup, before treating a clean audit as meaningful.
            </p>
            <p className="mt-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                Connect Splitwise
              </Button>
            </p>
          </AlertDescription>
        </Alert>
      )}

      {!neverRead && (
        <p className="text-meta text-ink-muted">
          Connected.{" "}
          <Button variant="link" size="sm" onClick={() => setOpen(true)}>
            Re-record the connection
          </Button>
        </p>
      )}

      <DecisionDialog
        open={open}
        onClose={() => {
          setOpen(false);
          connect.reset();
        }}
        title="Connect Splitwise"
        consequence={
          <>
            This records that a Splitwise integration exists, so audits and syncs know to use it. It
            sends nothing to Splitwise and reads nothing from it. The API credentials live in the
            server&apos;s environment, never here.
          </>
        }
        confirmLabel="Record it"
        reasonLabel="Note for the audit trail"
        pending={connect.isPending}
        error={connect.error}
        onConfirm={() => {
          connect.mutate(
            externalAccountRef.trim() === ""
              ? {}
              : { externalAccountRef: externalAccountRef.trim() },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="splitwise-account-ref">Splitwise account reference</Label>
          <Input
            id="splitwise-account-ref"
            value={externalAccountRef}
            placeholder="Optional — your Splitwise user id"
            onChange={(event) => setExternalAccountRef(event.target.value)}
            className="font-mono text-meta"
          />
          <p className="text-micro text-ink-faint">
            Stored for traceability only. Splitwise&apos;s numbers are reconciled against, never
            trusted (`CLAUDE.md`, principle 9).
          </p>
        </div>
      </DecisionDialog>
    </>
  );
}
