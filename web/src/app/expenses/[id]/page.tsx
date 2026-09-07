import { BackLink } from "@/components/back-link";
import { ExpenseDetail } from "@/components/expenses/expense-detail";

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/expenses">Expenses</BackLink>
      <ExpenseDetail expenseId={id} />
    </div>
  );
}
