import { BackLink } from "@/components/back-link";
import { ShareExpense } from "@/components/people/share-expense";

/**
 * Where *Who shared this expense?* goes.
 *
 * The full editor is still on `/expenses/[id]`, linked from the foot of this one. This route
 * asks the question a person actually has, splits evenly by default, and shows what the ledger
 * would write before it writes it.
 */
export default async function ShareExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/expenses/${id}`}>This expense</BackLink>
      <ShareExpense expenseId={id} />
    </div>
  );
}
