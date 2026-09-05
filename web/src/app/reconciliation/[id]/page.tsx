import Link from "next/link";
import { ReconciliationRunDetail } from "@/components/reconciliation-run-detail";

export default async function ReconciliationRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/reconciliation" className="text-meta text-ink-muted hover:text-ink">
        ← History
      </Link>
      <ReconciliationRunDetail id={id} />
    </div>
  );
}
