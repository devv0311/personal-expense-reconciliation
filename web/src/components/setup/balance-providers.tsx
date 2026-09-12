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
import {
  useAccounts,
  useBalanceProviderLinks,
  useBalanceProviderStatus,
  useLinkAccountToBalanceProvider,
  useUnlinkAccountFromBalanceProvider,
} from "@/lib/queries";
import type { AccountProviderLink } from "@/lib/types";

/**
 * Which of your accounts a live balance provider may be asked about (ADR-0054).
 *
 * Master data, like everything else on this page: it changes what the ledger can *ask*, never
 * what it says. Two things this screen is careful about:
 *
 * - **No credential is typed here.** The token lives in the server's environment. This maps an
 *   account to the provider's own reference for it, and there is deliberately no field that
 *   could hold a secret.
 * - **A reading is never a boundary.** Stated on the screen, not only in an ADR, because the
 *   obvious next thought on seeing a live balance is "use it to close the period" — and a
 *   `verified` ₹0 delta means evidence somebody confirmed, not a number an API returned.
 */
export function BalanceProviders() {
  const status = useBalanceProviderStatus();
  const links = useBalanceProviderLinks();
  const accounts = useAccounts();

  const [adding, setAdding] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [externalAccountRef, setExternalAccountRef] = useState("");
  const [unlinking, setUnlinking] = useState<AccountProviderLink | null>(null);

  const link = useLinkAccountToBalanceProvider();
  const unlink = useUnlinkAccountFromBalanceProvider();

  const linkedAccountIds = new Set((links.data ?? []).map((entry) => entry.accountId));
  const linkable = (accounts.data ?? []).filter((account) => !linkedAccountIds.has(account.id));

  return (
    <Section
      title="Live balances"
      headingId="balance-providers"
      description="An optional second opinion about what each account holds. A reading is compared against the waterfall and never becomes one of its boundaries — a boundary is a statement you evidenced."
      actions={
        status.data?.configured === true && linkable.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAccountId(linkable[0]?.id ?? "");
              setExternalAccountRef("");
              link.reset();
              setAdding(true);
            }}
          >
            Link an account
          </Button>
        ) : undefined
      }
    >
      {status.isPending && (
        <LoadingStatus label="Checking what can be read…">
          <TableSkeleton columns={3} />
        </LoadingStatus>
      )}
      {status.isError && <ErrorBlock error={status.error} onRetry={() => void status.refetch()} />}

      {status.isSuccess && !status.data.configured && (
        <div className="rounded-sm border border-rule bg-panel p-4">
          <p className="text-body text-ink">No balance provider is configured here.</p>
          <p className="mt-2 text-meta text-ink-muted">{status.data.unavailableReason}</p>
        </div>
      )}

      {status.isSuccess && status.data.configured && (
        <>
          <p className="mb-4 text-meta text-ink-muted">
            Reading from{" "}
            <span className="font-mono">{status.data.endpointHost ?? "a configured endpoint"}</span>{" "}
            as {status.data.label}. The credential lives in the server&apos;s environment and is
            never stored with this mapping.
          </p>

          {links.isPending && (
            <LoadingStatus label="Loading links…">
              <TableSkeleton columns={3} />
            </LoadingStatus>
          )}
          {links.isError && <ErrorBlock error={links.error} onRetry={() => void links.refetch()} />}
          {links.isSuccess &&
            (links.data.length === 0 ? (
              <EmptyBlock>
                No account is linked yet, so nothing is read. That is a statement about this
                mapping, not about any account&apos;s balance.
              </EmptyBlock>
            ) : (
              <Table>
                <TableCaption>Accounts a live balance can be read for</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Provider reference</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {links.data.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        {entry.accountName}
                        <span className="ml-2 text-micro text-ink-faint">
                          {accountTypeLabel(entry.accountType)}
                          {entry.accountLast4 === null ? "" : ` ····${entry.accountLast4}`}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-meta">{entry.externalAccountRef}</span>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            unlink.reset();
                            setUnlinking(entry);
                          }}
                        >
                          Unlink
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </>
      )}

      <DecisionDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Link an account to the balance provider"
        confirmLabel="Link it"
        confirmDisabled={accountId === "" || externalAccountRef.trim() === ""}
        pending={link.isPending}
        error={link.error}
        consequence={
          <>
            This lets the configured provider be asked about this account. It reads a balance and
            records what came back; it never writes a period boundary, and it can never make an
            unaccounted delta verified.
          </>
        }
        onConfirm={(reason) => {
          link.mutate(
            {
              accountId,
              externalAccountRef: externalAccountRef.trim(),
              ...(reason === undefined ? {} : { reason }),
            },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-account">Account</Label>
            <Select
              id="link-account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {linkable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="link-ref">The provider&apos;s reference for it</Label>
            <Input
              id="link-ref"
              value={externalAccountRef}
              onChange={(event) => setExternalAccountRef(event.target.value)}
            />
            <p className="text-micro text-ink-faint">
              The handle the provider uses — not an account number, and never a token.
            </p>
          </div>
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        title="Stop reading this account"
        confirmLabel="Unlink it"
        pending={unlink.isPending}
        error={unlink.error}
        consequence={
          <>
            The provider will no longer be asked about {unlinking?.accountName}. Readings already
            recorded stay exactly as they are — they are the record of what was said, and deleting
            them would rewrite it.
          </>
        }
        onConfirm={(reason) => {
          if (unlinking === null) return;
          unlink.mutate(
            { linkId: unlinking.id, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setUnlinking(null) },
          );
        }}
      />
    </Section>
  );
}
