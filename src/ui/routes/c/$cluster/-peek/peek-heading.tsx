import type { ReactNode } from "react";
import { formatCount } from "@/lib/count";

export function PeekHeading({
  title,
  count,
}: {
  title: string;
  count?: ReactNode;
}) {
  return (
    <h3 className="flex items-baseline gap-1.5 pb-1 pt-4 text-[11px] font-semibold text-fg">
      {title}
      {count != null && (
        <span className="font-normal text-fg-fnt">
          {typeof count === "number" ? formatCount(count) : count}
        </span>
      )}
    </h3>
  );
}
