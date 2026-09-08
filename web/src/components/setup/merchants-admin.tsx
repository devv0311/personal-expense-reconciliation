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
import { useAddMerchantAlias, useCreateMerchant, useMerchants } from "@/lib/queries";
import type { MerchantDetail } from "@/lib/types";

/**
 * The merchant catalog, and the aliases that make normalization resolve anything at all.
 *
 * The aliases are the point of this screen. Normalization matches an imported narration
 * against a stored pattern **exactly** — phase 7 kept it deterministic rather than fuzzy
 * (ADR-0022) — so "unknown merchant" is nearly always a missing alias, not a broken matcher.
 * Adding the narration here is the whole fix, and the next normalization run picks it up.
 */
export function MerchantsAdmin() {
  const [adding, setAdding] = useState(false);
  const [aliasFor, setAliasFor] = useState<MerchantDetail | null>(null);
  const [canonicalName, setCanonicalName] = useState("");
  const [defaultCategory, setDefaultCategory] = useState("");
  const [firstAlias, setFirstAlias] = useState("");
  const [aliasPattern, setAliasPattern] = useState("");

  const merchants = useMerchants();
  const create = useCreateMerchant();
  const addAlias = useAddMerchantAlias();

  return (
    <Section
      title="Merchants"
      headingId="merchants"
      description="Who a narration resolves to. Matching is exact, so a merchant with no alias for the text on your statement stays unknown."
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCanonicalName("");
            setDefaultCategory("");
            setFirstAlias("");
            create.reset();
            setAdding(true);
          }}
        >
          Add a merchant
        </Button>
      }
    >
      {merchants.isPending && (
        <LoadingStatus label="Loading merchants…">
          <TableSkeleton columns={3} />
        </LoadingStatus>
      )}
      {merchants.isError && (
        <ErrorBlock error={merchants.error} onRetry={() => void merchants.refetch()} />
      )}
      {merchants.isSuccess && merchants.data.length === 0 && (
        <EmptyBlock>
          No merchants yet. Until one exists with a matching alias, every imported narration
          normalizes to an unknown counterparty.
        </EmptyBlock>
      )}
      {merchants.isSuccess && merchants.data.length > 0 && (
        <Table className="min-w-[560px]">
          <TableCaption>Merchant catalog</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Merchant</TableHead>
              <TableHead scope="col">Narrations it matches</TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {merchants.data.map((merchant) => (
              <TableRow key={merchant.id} className="align-top">
                <TableCell>
                  {merchant.canonicalName}
                  <div className="mt-0.5 text-micro text-ink-faint">
                    {merchant.defaultCategory ?? "No default category"}
                    {merchant.archivedAt === null ? "" : " · archived"}
                  </div>
                </TableCell>
                <TableCell>
                  {merchant.aliases.length === 0 ? (
                    <span className="text-meta text-attention">
                      None — nothing will ever resolve to it
                    </span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {merchant.aliases.map((alias) => (
                        <li key={alias.id} className="font-mono text-micro text-ink-muted">
                          {alias.rawPattern}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      setAliasPattern("");
                      addAlias.reset();
                      setAliasFor(merchant);
                    }}
                  >
                    Add alias
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
        title="Add a merchant"
        consequence="This adds a merchant the next normalization run can resolve narrations to. It changes nothing already imported — normalization is what applies it, and only to payments still waiting."
        confirmLabel="Add it"
        confirmDisabled={canonicalName.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={create.isPending}
        error={create.error}
        onConfirm={() => {
          create.mutate(
            {
              canonicalName: canonicalName.trim(),
              ...(defaultCategory.trim() === "" ? {} : { defaultCategory: defaultCategory.trim() }),
              ...(firstAlias.trim() === "" ? {} : { aliases: [firstAlias.trim()] }),
            },
            { onSuccess: () => setAdding(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="merchant-name">Name</Label>
            <Input
              id="merchant-name"
              value={canonicalName}
              placeholder="Blinkit"
              onChange={(event) => setCanonicalName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="merchant-category">Default category</Label>
            <Input
              id="merchant-category"
              value={defaultCategory}
              placeholder="groceries"
              onChange={(event) => setDefaultCategory(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="merchant-alias">First narration to match</Label>
            <Input
              id="merchant-alias"
              value={firstAlias}
              placeholder="UPI-BLINKIT-PAYU@AXIS"
              onChange={(event) => setFirstAlias(event.target.value)}
              className="font-mono text-meta"
            />
            <p className="text-micro text-ink-faint">
              Copy it from the movement exactly. The match is exact, not fuzzy.
            </p>
          </div>
        </div>
      </DecisionDialog>

      <DecisionDialog
        open={aliasFor !== null}
        onClose={() => setAliasFor(null)}
        title={aliasFor === null ? "Add alias" : `Teach ${aliasFor.canonicalName} a narration`}
        consequence="This makes the next normalization run resolve that exact narration to this merchant. Payments already normalized keep the counterparty they were given — nothing is rewritten behind you."
        confirmLabel="Add it"
        confirmDisabled={aliasPattern.trim() === ""}
        reasonLabel="Note for the audit trail"
        pending={addAlias.isPending}
        error={addAlias.error}
        onConfirm={() => {
          if (aliasFor === null) return;
          addAlias.mutate(
            { merchantId: aliasFor.id, rawPattern: aliasPattern.trim() },
            { onSuccess: () => setAliasFor(null) },
          );
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="alias-pattern">Narration</Label>
          <Input
            id="alias-pattern"
            value={aliasPattern}
            onChange={(event) => setAliasPattern(event.target.value)}
            className="font-mono text-meta"
          />
        </div>
      </DecisionDialog>
    </Section>
  );
}
