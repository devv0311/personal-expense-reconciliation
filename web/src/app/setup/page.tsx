import { PageHeader } from "@/components/page-header";
import { AccountsAdmin } from "@/components/setup/accounts-admin";
import { BalanceProviders } from "@/components/setup/balance-providers";
import { GroupsAdmin } from "@/components/setup/groups-admin";
import { MerchantsAdmin } from "@/components/setup/merchants-admin";
import { PeopleAdmin } from "@/components/setup/people-admin";

/**
 * The roster a fresh installation has to build before any financial screen means anything:
 * who money moves between, which accounts it moves through, who a narration resolves to, and
 * which groups exist.
 *
 * None of it is financial. Nothing on this page creates an expense, an obligation or a payment
 * — which is exactly why it is one page and not four scattered dialogs. The live-balance
 * mapping joins it for the same reason: it changes which accounts can be *asked* about, and a
 * reading is never a boundary (ADR-0054).
 */
export default function SetupPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Setup"
        description="People, accounts, merchants and groups. Everything here is master data: it changes what the ledger can say, never what it already says."
      />
      <PeopleAdmin />
      <AccountsAdmin />
      <BalanceProviders />
      <MerchantsAdmin />
      <GroupsAdmin />
    </div>
  );
}
