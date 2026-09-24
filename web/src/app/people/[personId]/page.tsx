import { BackLink } from "@/components/back-link";
import { PersonBalance } from "@/components/people/person-balance";

/**
 * One person: what the balance is, and every event that makes it up.
 *
 * `/balances` still exists and still answers the same question for any two people, with the
 * supersession history and the evidence status spelled out. This is the same figure for the
 * pair a person actually asked about, said in events rather than in contributions.
 */
export default async function PersonPage({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  return (
    <div className="flex flex-col gap-8">
      <BackLink href="/people">People</BackLink>
      <PersonBalance personId={personId} />
    </div>
  );
}
