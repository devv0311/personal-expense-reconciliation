import { EvidenceInspector } from "@/components/evidence/evidence-inspector";
import { BackLink } from "@/components/back-link";

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/review">Review queue</BackLink>
      <EvidenceInspector evidenceId={id} />
    </div>
  );
}
