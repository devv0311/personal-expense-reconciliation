import Link from "next/link";
import type { ReactNode } from "react";

/** The `←` breadcrumb phase 15 established on the run detail, shared by every detail screen. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-meta text-ink-muted transition-colors hover:text-ink">
      <span aria-hidden="true">←</span> {children}
    </Link>
  );
}
