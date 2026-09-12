import { BackLink } from "@/components/back-link";
import { RemoteChangeDetail } from "@/components/splitwise/remote-change-detail";

export default async function RemoteChangePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href="/splitwise">Splitwise</BackLink>
      <RemoteChangeDetail changeId={id} />
    </div>
  );
}
