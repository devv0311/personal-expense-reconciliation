import type { ReactNode } from "react";

/**
 * The one `text-h1` per screen, plus the sentence that says what the screen answers.
 *
 * A component rather than a copied block so the type scale, the max-width and the spacing are
 * decided once — `Design.md`'s "one page-title heading per screen" is easier to keep true when
 * there is exactly one place that renders one.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rule pb-6">
      <div>
        <h1 className="text-h1 font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-2 max-w-prose text-body leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}

/** A titled block. The heading is real (`<h2>`), so the page outline reads correctly. */
export function Section({
  title,
  description,
  actions,
  children,
  headingId,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingId: string;
}) {
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-emphasis font-medium text-ink">
            {title}
          </h2>
          {description !== undefined && (
            <p className="mt-1 max-w-prose text-meta text-ink-muted">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
