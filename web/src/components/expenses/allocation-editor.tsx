"use client";

import { useState } from "react";
import { Money } from "@/components/money";
import { DecisionDialog } from "@/components/review/decision-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { allocationMethodLabel } from "@/lib/labels";
import { parseRupeeInput, sumPaise } from "@/lib/money";
import { useApproveAllocation, useExpenseItems, useGroups, usePeople } from "@/lib/queries";
import type { AllocationDecisionInput } from "@/lib/api";
import {
  ALLOCATION_METHODS,
  type AllocationMethod,
  type BeneficiaryRef,
  type ExpenseLedgerRow,
} from "@/lib/types";

/**
 * Naming who benefited from an expense, and how it divides between them.
 *
 * This is the control the audit found missing entirely: an expense could be approved and then
 * had nowhere to go, because there was no way to author an allocation from the browser. It is
 * also the correction path — approving a second time supersedes the current version rather
 * than editing it, which is why there is one button and not two.
 *
 * **What this screen sends and what it never sends.** It names beneficiaries, states a method,
 * and passes through exactly what a person typed (an exact amount, a percentage, a unit count).
 * Every amount that comes *out* of a division — an equal split's shares, a percentage applied
 * to the gross, a group expanded into its members, a shared item split by units — is computed
 * by the domain under the Largest Remainder Method (`invariants.md` #12). The only figure this
 * file adds up is the echo under the exact/percentage fields, which is labelled as a check on
 * what was typed and is never rendered as a ledger figure (ADR-0048).
 */
export function AllocationEditor({
  expense,
  hasCurrentAllocation,
}: {
  expense: ExpenseLedgerRow;
  hasCurrentAllocation: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<AllocationMethod>("equal");
  const [chosen, setChosen] = useState<readonly BeneficiaryRef[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [itemClaims, setItemClaims] = useState<Record<string, string>>({});

  const people = usePeople();
  const groups = useGroups();
  const items = useExpenseItems(expense.id);
  const approve = useApproveAllocation(expense.id);

  const itemSourced = method === "item_based" || method === "quantity_based";
  const beneficiaryKey = (ref: BeneficiaryRef) => `${ref.type}:${ref.id}`;
  const claimKey = (itemId: string, ref: BeneficiaryRef) => `${itemId}|${beneficiaryKey(ref)}`;

  const toggle = (ref: BeneficiaryRef) => {
    setChosen((current) =>
      current.some((entry) => beneficiaryKey(entry) === beneficiaryKey(ref))
        ? current.filter((entry) => beneficiaryKey(entry) !== beneficiaryKey(ref))
        : [...current, ref],
    );
  };

  const decision = buildDecision({
    method,
    chosen,
    amounts,
    percentages,
    itemClaims,
    claimKey,
    beneficiaryKey,
  });

  const typedTotal =
    method === "exact" || method === "custom"
      ? sumTyped(chosen.map((ref) => amounts[beneficiaryKey(ref)] ?? ""))
      : null;
  const percentageTotal =
    method === "percentage"
      ? chosen.reduce((total, ref) => {
          const raw = Number.parseFloat(percentages[beneficiaryKey(ref)] ?? "");
          return Number.isFinite(raw) ? total + raw : total;
        }, 0)
      : null;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {hasCurrentAllocation ? "Change the split" : "Name who benefited"}
      </Button>

      <DecisionDialog
        open={open}
        onClose={() => {
          setOpen(false);
          approve.reset();
        }}
        title={hasCurrentAllocation ? "Replace this allocation" : "Approve an allocation"}
        consequence={
          hasCurrentAllocation ? (
            <>
              This approves a <strong>new version</strong> and supersedes the current one. The old
              version is kept — an allocation is never edited in place — and what each person owes
              moves to the new shares.
            </>
          ) : (
            <>
              This is what creates obligations: each beneficiary other than the payer will owe their
              share to <strong>whoever fronted the money</strong>, not automatically to you. The
              amounts are computed by the ledger from what you state here.
            </>
          )
        }
        confirmLabel="Approve it"
        confirmDisabled={decision === null}
        reasonLabel="Why this split"
        pending={approve.isPending}
        error={approve.error}
        onConfirm={(reason) => {
          if (decision === null) return;
          approve.mutate(
            { decision, ...(reason === undefined ? {} : { reason }) },
            { onSuccess: () => setOpen(false) },
          );
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="allocation-method">Method</Label>
            <Select
              id="allocation-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as AllocationMethod)}
            >
              {ALLOCATION_METHODS.map((option) => (
                <option key={option} value={option}>
                  {allocationMethodLabel(option)}
                </option>
              ))}
            </Select>
            <p className="text-micro text-ink-faint">{METHOD_HINTS[method]}</p>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-meta text-ink-muted">Beneficiaries</legend>
            {(people.data ?? []).map((person) => {
              const ref: BeneficiaryRef = { type: "person", id: person.id };
              return (
                <BeneficiaryRow
                  key={person.id}
                  label={`${person.displayName}${person.isUser ? " (you)" : ""}`}
                  checked={chosen.some((entry) => beneficiaryKey(entry) === beneficiaryKey(ref))}
                  onToggle={() => toggle(ref)}
                >
                  {method === "exact" || method === "custom" ? (
                    <AmountField
                      id={`amount-${person.id}`}
                      value={amounts[beneficiaryKey(ref)] ?? ""}
                      onChange={(value) =>
                        setAmounts((current) => ({ ...current, [beneficiaryKey(ref)]: value }))
                      }
                    />
                  ) : method === "percentage" ? (
                    <PercentageField
                      id={`pct-${person.id}`}
                      value={percentages[beneficiaryKey(ref)] ?? ""}
                      onChange={(value) =>
                        setPercentages((current) => ({ ...current, [beneficiaryKey(ref)]: value }))
                      }
                    />
                  ) : null}
                </BeneficiaryRow>
              );
            })}
            {(groups.data ?? []).map((group) => {
              const ref: BeneficiaryRef = { type: "group", id: group.id };
              return (
                <BeneficiaryRow
                  key={group.id}
                  label={`${group.name} (group of ${group.memberships.length})`}
                  checked={chosen.some((entry) => beneficiaryKey(entry) === beneficiaryKey(ref))}
                  onToggle={() => toggle(ref)}
                >
                  {method === "exact" || method === "custom" ? (
                    <AmountField
                      id={`amount-${group.id}`}
                      value={amounts[beneficiaryKey(ref)] ?? ""}
                      onChange={(value) =>
                        setAmounts((current) => ({ ...current, [beneficiaryKey(ref)]: value }))
                      }
                    />
                  ) : method === "percentage" ? (
                    <PercentageField
                      id={`pct-${group.id}`}
                      value={percentages[beneficiaryKey(ref)] ?? ""}
                      onChange={(value) =>
                        setPercentages((current) => ({ ...current, [beneficiaryKey(ref)]: value }))
                      }
                    />
                  ) : null}
                </BeneficiaryRow>
              );
            })}
            {chosen.some((entry) => entry.type === "group") && (
              <p className="text-micro text-ink-faint">
                A group is expanded into the people who were members on this expense&apos;s date,
                and the expansion is snapshotted. The group itself never owes anything.
              </p>
            )}
          </fieldset>

          {itemSourced && (
            <fieldset className="flex flex-col gap-3">
              <legend className="text-meta text-ink-muted">
                Who had what
                {method === "quantity_based" ? ", and how many" : ""}
              </legend>
              {items.isSuccess && items.data.length === 0 && (
                <p className="text-meta text-attention">
                  This expense has no item breakdown, so there is nothing to allocate per item.
                  Record the items first.
                </p>
              )}
              {(items.data ?? []).map((item) => (
                <div key={item.id} className="border-b border-rule pb-2 last:border-b-0">
                  <p className="text-body text-ink">
                    {item.description} <Money paise={item.amount} className="ml-1 text-meta" />
                  </p>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {chosen.map((ref) => (
                      <label
                        key={claimKey(item.id, ref)}
                        className="flex items-center gap-2 text-meta text-ink"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--color-accent)]"
                          checked={itemClaims[claimKey(item.id, ref)] !== undefined}
                          onChange={(event) =>
                            setItemClaims((current) => {
                              const next = { ...current };
                              if (event.target.checked) {
                                next[claimKey(item.id, ref)] = "1";
                              } else {
                                delete next[claimKey(item.id, ref)];
                              }
                              return next;
                            })
                          }
                        />
                        {labelFor(ref, people.data ?? [], groups.data ?? [])}
                        {method === "quantity_based" &&
                          itemClaims[claimKey(item.id, ref)] !== undefined && (
                            <Input
                              aria-label={`Units of ${item.description} for ${labelFor(
                                ref,
                                people.data ?? [],
                                groups.data ?? [],
                              )}`}
                              value={itemClaims[claimKey(item.id, ref)] ?? ""}
                              inputMode="numeric"
                              onChange={(event) =>
                                setItemClaims((current) => ({
                                  ...current,
                                  [claimKey(item.id, ref)]: event.target.value,
                                }))
                              }
                              className="h-7 w-16 font-mono text-meta"
                            />
                          )}
                      </label>
                    ))}
                    {chosen.length === 0 && (
                      <span className="text-micro text-ink-faint">
                        Choose beneficiaries above first.
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </fieldset>
          )}

          {typedTotal !== null && (
            <p className="text-meta text-ink-muted">
              Entered so far: <Money paise={typedTotal} /> — an entry check against the{" "}
              <Money paise={expense.grossAmount} /> gross, not a ledger figure. The ledger refuses a
              set that does not sum to it.
            </p>
          )}
          {percentageTotal !== null && (
            <p className="text-meta text-ink-muted">
              Entered so far: {percentageTotal}% — the ledger refuses anything but 100.
            </p>
          )}
          {decision === null && (
            <p className="text-meta text-ink-muted">
              {method === "equal"
                ? "Choose at least one beneficiary."
                : "Every chosen beneficiary needs a value before this can be approved."}
            </p>
          )}
        </div>
      </DecisionDialog>
    </>
  );
}

const METHOD_HINTS: Record<AllocationMethod, string> = {
  equal:
    "Split evenly. The ledger divides and hands any leftover paise out by the same rule every split uses.",
  exact: "State each share yourself. They must sum to the gross amount.",
  percentage: "State each share as a percentage. They must sum to 100.",
  item_based: "Each item's cost goes to whoever had it.",
  quantity_based:
    "Each item's cost is split across the people who had it, by how many units each took.",
  custom: "Exact amounts, recorded as a deliberate non-standard split.",
};

function BeneficiaryRow({
  label,
  checked,
  onToggle,
  children,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-body text-ink">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-accent)]"
          checked={checked}
          onChange={onToggle}
        />
        {label}
      </label>
      {checked && children}
    </div>
  );
}

function AmountField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      aria-label="Share"
      inputMode="decimal"
      placeholder="0.00"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-32 font-mono"
    />
  );
}

function PercentageField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      aria-label="Percentage"
      inputMode="decimal"
      placeholder="50"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-24 font-mono"
    />
  );
}

function labelFor(
  ref: BeneficiaryRef,
  people: readonly { id: string; displayName: string }[],
  groups: readonly { id: string; name: string }[],
): string {
  if (ref.type === "person") {
    return people.find((person) => person.id === ref.id)?.displayName ?? "Someone";
  }
  return groups.find((group) => group.id === ref.id)?.name ?? "A group";
}

/** Adds up only what a person typed into this form, for the entry check above. */
function sumTyped(values: readonly string[]): string {
  const parsed = values.map((value) => parseRupeeInput(value)).filter((entry) => entry.ok);
  return sumPaise(parsed.map((entry) => (entry.ok ? entry.paise : "0")));
}

/** `null` until the form is complete — the confirm button reads this, and so does nothing else. */
function buildDecision(input: {
  method: AllocationMethod;
  chosen: readonly BeneficiaryRef[];
  amounts: Record<string, string>;
  percentages: Record<string, string>;
  itemClaims: Record<string, string>;
  claimKey: (itemId: string, ref: BeneficiaryRef) => string;
  beneficiaryKey: (ref: BeneficiaryRef) => string;
}): AllocationDecisionInput | null {
  const { method, chosen, amounts, percentages, itemClaims, beneficiaryKey } = input;
  if (chosen.length === 0) return null;

  if (method === "equal") return { method: "equal", beneficiaries: chosen };

  if (method === "exact" || method === "custom") {
    const lines: { beneficiary: BeneficiaryRef; amount: string }[] = [];
    for (const beneficiary of chosen) {
      const parsed = parseRupeeInput(amounts[beneficiaryKey(beneficiary)] ?? "");
      if (!parsed.ok) return null;
      lines.push({ beneficiary, amount: parsed.paise });
    }
    return { method, lines };
  }

  if (method === "percentage") {
    const lines: { beneficiary: BeneficiaryRef; percentage: string }[] = [];
    for (const beneficiary of chosen) {
      const raw = (percentages[beneficiaryKey(beneficiary)] ?? "").trim();
      if (raw === "" || !/^\d+(\.\d+)?$/.test(raw)) return null;
      lines.push({ beneficiary, percentage: raw });
    }
    return { method: "percentage", lines };
  }

  const lines: {
    beneficiary: BeneficiaryRef;
    expenseItemId: string;
    units?: string;
  }[] = [];
  for (const [key, units] of Object.entries(itemClaims)) {
    const [expenseItemId = "", beneficiaryPart = ""] = key.split("|");
    const [type = "", id = ""] = beneficiaryPart.split(":");
    if (expenseItemId === "" || (type !== "person" && type !== "group")) return null;
    const beneficiary: BeneficiaryRef = { type, id };
    if (method === "quantity_based") {
      if (!/^\d+$/.test(units.trim())) return null;
      lines.push({ beneficiary, expenseItemId, units: units.trim() });
    } else {
      lines.push({ beneficiary, expenseItemId });
    }
  }
  if (lines.length === 0) return null;
  return { method, lines };
}
