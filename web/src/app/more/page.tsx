import { RecordsIndex } from "@/app/records/page";

/**
 * The old address for what is now **Records**.
 *
 * Kept, and kept rendering the same page rather than redirecting, because a bookmark and a deep
 * link from an older note are exactly the readers this product promised not to break — every
 * route that has ever worked still works. A redirect would also do that; rendering avoids a
 * round trip and keeps the two impossible to drift apart.
 */
export default function MorePage() {
  return <RecordsIndex />;
}
