import type { ReactNode } from "react";

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
        <span className="font-normal text-fg-fnt">{count}</span>
      )}
    </h3>
  );
}
