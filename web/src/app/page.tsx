import { Overview } from "@/components/overview/overview";
import { PageHeader } from "@/components/page-header";

/**
 * The front door.
 *
 * It used to redirect to `/reconciliation` — the most specialist screen in the product, named
 * after the mechanism rather than the result. Somebody arriving here wants to know what needs
 * them, what they spent, and who owes whom; the reconciliation run that proves those figures is
 * the evidence, not the headline, and it is still one click away under Records.
 *
 * The page title is deliberately not a figure and not a summary. This screen's first job is to
 * hand the reader one decision, and `Overview` puts that decision directly under this heading.
 */
export default function HomePage() {
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Home"
        description="What needs you next, and where things stand. Nothing on this page decides anything."
      />
      <Overview />
    </div>
  );
}
