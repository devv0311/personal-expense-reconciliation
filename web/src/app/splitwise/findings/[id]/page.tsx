import { BackLink } from "@/components/back-link";
import { AuditFindingDetail } from "@/components/splitwise/finding-detail";

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/splitwise">Splitwise audit</BackLink>
      <AuditFindingDetail findingId={id} />
    </div>
  );
}
