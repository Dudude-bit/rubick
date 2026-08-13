import * as React from "react";
import { cn } from "@/lib/utils";

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /**
   * The scroll port around the table. A sticky header anchors to it and a
   * virtualiser measures it, and both want the element that genuinely
   * scrolls — a second wrapper outside this one gives them neither.
   */
  containerRef?: React.Ref<HTMLDivElement>;
  containerClassName?: string;
  containerStyle?: React.CSSProperties;
}

/**
 * The table sits directly on the canvas. No wrapper border, no rounding,
 * no zebra: structure comes from alignment and from one hairline per row.
 * A box around a list of rows is the card pattern in disguise.
 */
const Table = React.forwardRef<HTMLTableElement, TableProps>(
  (
    { className, containerRef, containerClassName, containerStyle, ...props },
    ref
  ) => (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-auto", containerClassName)}
      style={containerStyle}
    >
      <table
        ref={ref}
        // Layout is the caller's to choose. `DataTable` asks for `table-fixed`
        // because every one of its columns declares a width; the dozen small
        // tables that declare none must stay on auto, where fixed layout would
        // divide the width equally and give a revision number the same room as
        // a sentence.
        className={cn(
          "w-full caption-bottom border-collapse text-xs",
          className
        )}
        {...props}
      />
    </div>
  )
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={className} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    // Hover belongs to data rows only — a header or a group caption that
    // lights up on mouse-over reads as clickable when it is not. Those
    // rows opt out with `data-quiet`; the attribute selector outranks the
    // plain one, so the opt-out wins regardless of utility order.
    className={cn(
      "[&>tr:hover]:bg-hover [&>tr[data-quiet]:hover]:bg-transparent [&>tr:last-child]:border-0",
      className
    )}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t border-hair font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b border-hair transition-colors data-[state=selected]:bg-sel",
      className
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    // The header is a label, not a band: 11px at the faintest foreground,
    // sentence case. Uppercase + tracking made it shout over the data.
    // `whitespace-nowrap` stops two-word labels ("CPU Usage") from
    // wrapping and doubling the header's height.
    className={cn(
      "whitespace-nowrap px-2.5 py-1 text-left align-middle text-[11px] font-medium text-fg-fnt [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "px-2.5 py-1 align-middle [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-xs text-fg-mut", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
