import { JobsPanel } from "@/components/automation/jobs-panel";
import { RulesAdmin } from "@/components/automation/rules-admin";
import { PageHeader } from "@/components/page-header";

/**
 * The two things this ledger does without being asked each time — and the limits on both.
 *
 * A **rule** restates a decision a person already made, over payments matching it exactly. A
 * **job** orchestrates service calls that already refuse to write approved state on their own.
 * Neither decides an amount, and neither approves anything: the AI boundary and the evidence
 * gates stand between both of them and any authoritative figure.
 */
export default function AutomationPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Automation"
        description="Standing rules, and the background queue. Nothing here decides an amount or approves a financial decision — both only ever produce a label or a queue item."
      />
      <RulesAdmin />
      <JobsPanel />
    </div>
  );
}
