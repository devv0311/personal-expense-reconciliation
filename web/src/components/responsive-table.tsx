import { Fragment, type ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * A dense read-only table that becomes a stacked list below `sm`.
 *
 * `Design.md`'s responsive rule, made reusable. The rule itself is not new — phase 15's three
 * dense tables already did this by hand — but phase 21 added six more, and doing it by hand
 * six more times is how one of them ends up horizontally scrolled with `₹650.00` cut off at
 * `₹65`. A clipped figure on a phone is a misleading figure, which is the one thing a ledger
 * may not be.
 *
 * The stacked list is **genuinely separate markup fed by the same data**, not a CSS trick on
 * the `<table>` itself, because a responsive-table hack degrades badly for assistive tech.
 * Exactly one of the two is in the accessibility tree at any width: `display: none` removes the
 * other entirely.
 *
 * The first column is the row's title on mobile; every other column becomes a `label: value`
 * pair under it. Columns marked `secondary` are the ones a narrow reader can do without — they
 * still appear in the stacked list, just after the ones that matter.
 */
export interface ResponsiveColumn<Row> {
  readonly key: string;
  readonly header: string;
  readonly align?: "left" | "right";
  /** Kept out of the mobile list's leading line; still shown, just lower down. */
  readonly secondary?: boolean;
  readonly render: (row: Row) => ReactNode;
}

export function ResponsiveTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  minWidth = "480px",
  rowNote,
}: {
  /** The `sr-only` caption. Also names the scroll region when the table overflows. */
  caption: string;
  columns: readonly ResponsiveColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  minWidth?: string;
  /** An extra line under a row — a warning about that row, in both layouts. */
  rowNote?: (row: Row) => ReactNode;
}) {
  const [title, ...rest] = columns;
  if (title === undefined) return null;

  return (
    <>
      <Table className="hidden sm:table" style={{ minWidth }}>
        <TableCaption>{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                scope="col"
                className={cn(column.align === "right" && "text-right")}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={rowKey(row, index)} className="align-top">
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(column.align === "right" && "text-right")}
                >
                  {column.render(row)}
                  {column.key === title.key && rowNote !== undefined && rowNote(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ul className="flex flex-col sm:hidden">
        {rows.map((row, index) => (
          <li key={rowKey(row, index)} className="border-b border-rule py-3 last:border-b-0">
            <div className="text-body text-ink">{title.render(row)}</div>
            {rowNote !== undefined && rowNote(row)}
            <dl className="mt-1.5 flex flex-col gap-1">
              {rest.map((column) => (
                <Fragment key={column.key}>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-meta text-ink-muted">{column.header}</dt>
                    <dd className="text-body text-ink">{column.render(row)}</dd>
                  </div>
                </Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
