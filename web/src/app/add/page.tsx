import { AddRecords } from "@/components/add/add-records";
import { PageHeader } from "@/components/page-header";

/**
 * The obvious first thing to do, and the only place a person needs to know about to do it.
 *
 * This page used to be four links out to screens named after the machinery behind them —
 * `/payments/import`, the evidence library, a query string on the payment workspace. Each was
 * a correct destination and none of them was a place somebody holding a receipt would have
 * thought to look. Everything now happens here; those screens are unchanged and still reachable
 * from More for anybody who wants the batch history or the full library.
 */
export default function AddRecordsPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Add records"
        description="Anything that says money moved, or says what it was for. The more you add, the more this can work out on its own — and the less it has to ask you."
      />
      <AddRecords />
    </div>
  );
}
