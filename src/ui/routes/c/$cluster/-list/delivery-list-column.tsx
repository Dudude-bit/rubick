import type { ColumnDef, RowData } from "@/components/ui/table-features";
import { CELL_PADS_PX } from "@/components/ui/column-shares";
import { columnHeader } from "@/i18n/column-header";
import { widestText } from "@/lib/text-width";
import { DeliveryColumnCell } from "../-delivery/delivery-column";
import { YIELDS_AFTER_THE_LIST } from "./columns";

/**
 * The column, built once because every list that has one gets exactly this one
 * — and because `flexRender` treats a cell renderer as a React element type.
 * A renderer rebuilt per render remounts its cell on every watch tick; see
 * `RowActions` in `data-table.tsx` for what that cost the row's buttons.
 */
export const DELIVERY_COLUMN: ColumnDef<never> = {
  size: 150,
  id: "delivery",
  header: columnHeader("columns", "delivery"),
  enableSorting: false,
  meta: {
    floor: (t) =>
      widestText(
        [
          t("readings", "delNotDelivered"),
          t("readings", "delLabelledNotListedShort"),
          t("readings", "delTwoControllers"),
        ],
        "sans",
        6.2
      ) + CELL_PADS_PX,
    // Never hidden, it scrolled the table sideways beside a peek, past a
    // footer that named every hidden column but it.
    yields: YIELDS_AFTER_THE_LIST,
  },
  cell: ({ row }) => <DeliveryColumnCell row={row.original} />,
};

export const deliveryColumn = <Row extends RowData>() =>
  DELIVERY_COLUMN as ColumnDef<Row>;
