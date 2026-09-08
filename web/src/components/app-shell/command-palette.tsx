"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatPeriod } from "@/lib/dates";
import { usePeople, useReconciliationRuns, useSplitwiseAuditFindings } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * `Cmd+K` / `Ctrl+K` — the one place to reach anything in the product.
 *
 * Everything it offers is **navigation**. There is no "approve", no "distribute", no "copy": a
 * command palette is a fast way to arrive at a decision, never a fast way to make one
 * (ADR-0049). A person still reads the screen and presses the button.
 *
 * It is a `role="listbox"` of `role="option"`s driven by `aria-activedescendant`, so the search
 * field keeps focus while the arrow keys move the selection — the pattern a combobox needs and
 * the one behavior in this app a plain `<select>` genuinely cannot provide (`Design.md`,
 * "Forms: native controls, deliberately").
 *
 * Data comes from the same reads the screens use, fetched only while the palette is open.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} />;
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: string;
  readonly href: string;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const people = usePeople();
  const runs = useReconciliationRuns(5);
  const findings = useSplitwiseAuditFindings({ reviewStatus: "open", limit: 5 });

  const commands = useMemo<readonly Command[]>(() => {
    const sections: Command[] = [
      { id: "go-review", label: "Review queue", hint: "g v", group: "Go to", href: "/review" },
      { id: "go-payments", label: "Payments", hint: "g m", group: "Go to", href: "/payments" },
      {
        id: "go-unexplained",
        label: "Payments with no explanation",
        hint: "Every unexplained movement",
        group: "Go to",
        href: "/payments?onlyUnexplained=true",
      },
      {
        id: "go-import",
        label: "Import a statement",
        hint: "CSV",
        group: "Go to",
        href: "/payments/import",
      },
      {
        id: "go-reconciliation",
        label: "Reconciliation",
        hint: "g r",
        group: "Go to",
        href: "/reconciliation",
      },
      { id: "go-expenses", label: "Expenses", hint: "g e", group: "Go to", href: "/expenses" },
      { id: "go-balances", label: "Balances", hint: "g b", group: "Go to", href: "/balances" },
      {
        id: "go-splitwise",
        label: "Splitwise audit",
        hint: "g s",
        group: "Go to",
        href: "/splitwise",
      },
      {
        id: "go-proof-packs",
        label: "Proof packs",
        hint: "g p",
        group: "Go to",
        href: "/proof-packs",
      },
      { id: "go-setup", label: "Setup", hint: "g t", group: "Go to", href: "/setup" },
    ];

    for (const person of people.data ?? []) {
      if (person.isUser) continue;
      sections.push({
        id: `balance-${person.id}`,
        label: `Balance with ${person.displayName}`,
        hint: "Who owes whom",
        group: "People",
        href: `/balances?with=${person.id}`,
      });
      sections.push({
        id: `pack-${person.id}`,
        label: `Proof pack for ${person.displayName}`,
        hint: "Preview before sharing",
        group: "People",
        href: `/proof-packs?recipient=${person.id}`,
      });
    }

    for (const run of runs.data ?? []) {
      sections.push({
        id: `run-${run.id}`,
        label: formatPeriod(run.periodStart, run.periodEnd),
        hint: "Reconciliation run",
        group: "Recent runs",
        href: `/reconciliation/${run.id}`,
      });
    }

    for (const finding of findings.data ?? []) {
      sections.push({
        id: `finding-${finding.id}`,
        label: finding.summary,
        hint: "Open finding",
        group: "Open findings",
        href: `/splitwise/findings/${finding.id}`,
      });
    }

    return sections;
  }, [people.data, runs.data, findings.data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return commands;
    return commands.filter((command) =>
      `${command.group} ${command.label} ${command.hint}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const active = filtered[Math.min(activeIndex, Math.max(filtered.length - 1, 0))];

  const run = (command: Command | undefined) => {
    if (command === undefined) return;
    onClose();
    router.push(command.href);
  };

  let lastGroup: string | null = null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Command palette"
      description="Type to search. Enter opens; Esc closes. Nothing here approves anything."
      className="max-w-xl"
    >
      <Input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={active === undefined ? undefined : `${listId}-${active.id}`}
        aria-label="Search commands"
        autoComplete="off"
        placeholder="Search screens, people, runs and findings…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // Typing narrows the list, so the highlight goes back to its top — done here rather
          // than in an effect watching `query`, which would be a second render for no reason.
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) =>
              filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            run(active);
          }
        }}
        className="w-full"
      />

      {filtered.length === 0 ? (
        <p className="mt-4 text-body text-ink-muted">Nothing matches &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="mt-3 max-h-80 overflow-y-auto"
        >
          {filtered.map((command, index) => {
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            const selected = command === active;
            return (
              <li key={command.id}>
                {showGroup && (
                  <p className="mt-3 mb-1 text-micro text-ink-faint first:mt-0">{command.group}</p>
                )}
                <div
                  id={`${listId}-${command.id}`}
                  role="option"
                  aria-selected={selected}
                  onClick={() => run(command)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex cursor-pointer items-baseline justify-between gap-4 rounded-sm px-2 py-1.5 text-body transition-colors",
                    selected ? "bg-accent-bg text-ink" : "text-ink-muted",
                  )}
                >
                  <span className="truncate">{command.label}</span>
                  <span className="shrink-0 font-mono text-micro text-ink-faint">
                    {command.hint}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
