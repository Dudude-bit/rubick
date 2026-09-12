import type { ReactNode } from "react";
import { AlertTriangle, Check, HelpCircle, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RowTone } from "./words";

const STEP_GLYPH: Record<RowTone, ReactNode> = {
  err: <X className="size-3" aria-hidden />,
  warn: <AlertTriangle className="size-3" aria-hidden />,
  ok: <Check className="size-3" aria-hidden />,
  none: <X className="size-3" aria-hidden />,
  mut: <HelpCircle className="size-3" aria-hidden />,
};

const STEP_RING: Record<RowTone, string> = {
  err: "border-err text-err",
  warn: "border-warn text-warn",
  ok: "border-ok text-ok",
  none: "border-err text-err",
  mut: "border-dashed border-fg-fnt text-fg-fnt",
};

export function Step({
  tone,
  title,
  count,
  last,
  children,
}: {
  tone: RowTone;
  title: string;
  count: string | null;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 pb-4">
      {!last && (
        <i
          className="absolute bottom-0 left-[10px] top-[22px] w-px bg-hair"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "z-[1] flex size-[22px] items-center justify-center rounded-full border-[1.5px] bg-canvas",
          STEP_RING[tone]
        )}
      >
        {STEP_GLYPH[tone]}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "flex items-baseline gap-2 text-[12.5px] font-medium leading-[22px]",
            tone === "err" || tone === "none"
              ? "text-err"
              : tone === "warn"
                ? "text-warn"
                : "text-fg"
          )}
        >
          {title}
          {count && (
            <span className="font-mono text-[11.5px] font-medium text-fg-mut">
              {count}
            </span>
          )}
        </p>
        <div className="text-xs text-fg-mut">{children}</div>
      </div>
    </div>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 flex flex-wrap gap-1.5">{children}</div>;
}

export function Chip({
  label,
  tone,
  children,
}: {
  label?: string;
  tone?: "err" | "mut";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 font-mono text-[11px]",
        tone === "err"
          ? "border-err/45 text-err"
          : tone === "mut"
            ? "border-dashed border-hair text-fg-fnt"
            : "border-hair text-fg-mid"
      )}
    >
      {label && <Sub>{label}</Sub>}
      {children}
    </span>
  );
}

export function Sub({ children }: { children: ReactNode }) {
  return <span className="font-sans text-[10px] text-fg-fnt">{children}</span>;
}
