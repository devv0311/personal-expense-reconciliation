"use client";

import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ShortcutSection } from "./shortcuts";

/**
 * `?` — every shortcut that currently applies, including the ones the open screen registered.
 *
 * Discoverability is the point: `CLAUDE.md` asks for "discoverable triage shortcuts", and a
 * shortcut nobody can find is a shortcut that does not exist. The list is assembled from the
 * same constants the listener uses, so it cannot drift out of date.
 */
export function ShortcutHelp({
  open,
  onClose,
  sections,
}: {
  open: boolean;
  onClose: () => void;
  sections: readonly ShortcutSection[];
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Shortcuts move you around and open things. Approving, distributing and copying stay explicit button presses."
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {sections.map((section) => (
          <div key={section.title}>
            <h3 className="mb-2 text-meta text-ink-muted">{section.title}</h3>
            <dl className="flex flex-col">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={`${section.title}-${shortcut.keys}`}
                  className="flex items-baseline justify-between gap-6 border-b border-rule py-1.5 last:border-b-0"
                >
                  <dt className="text-body text-ink">{shortcut.description}</dt>
                  <dd className="shrink-0 font-mono text-meta text-ink-muted">{shortcut.keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
