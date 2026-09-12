"use client";

import { AskPanel } from "@/components/ask/ask-panel";
import { PageHeader } from "@/components/page-header";

/**
 * The tenth AI operation's surface, and the only read-only one (ADR-0057).
 *
 * Deliberately not a chat: there is no history, no thread and no follow-up, because a
 * conversation implies a context that carries forward, and every answer here is derived fresh
 * from approved state and filed nowhere.
 */
export default function AskPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Ask"
        description="A question in words, answered from the ledger's own reads. The model chooses which read runs; every figure is the one the matching screen shows, and nothing here writes."
      />
      <AskPanel />
    </div>
  );
}
