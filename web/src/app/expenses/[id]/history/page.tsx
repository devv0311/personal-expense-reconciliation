import { BackLink } from "@/components/back-link";
import { ExpenseHistory } from "@/components/history/expense-history";
import { PageHeader } from "@/components/page-header";

export default async function ExpenseHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/expenses/${id}`}>The expense</BackLink>
      <PageHeader
        title="History"
        description="Every split this expense has had, and every decision recorded against it. Nothing here is recomputed — it is the log, read back."
      />
      <ExpenseHistory expenseId={id} />
    </div>
  );
}
