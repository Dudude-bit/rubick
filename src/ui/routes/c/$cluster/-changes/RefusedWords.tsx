import { useState } from "react";

import { NAMED_KINDS, unwatchedWords, type SpanCover } from "@/lib/changes";
import { useT } from "@/i18n/useT";

/**
 * What a span was refused, counted past a handful of kinds, with the names
 * one click away. Share keeps the whole list.
 */
export function RefusedWords({ span }: { span: SpanCover }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const full = unwatchedWords(span, t);
  const short = unwatchedWords(span, t, false, NAMED_KINDS);
  if (full === null) return null;
  if (full === short) return <>{full}</>;
  return (
    <>
      {open ? full : short}{" "}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-fg-mut underline-offset-2 hover:underline"
      >
        {t("action", open ? "hide" : "show")}
      </button>
    </>
  );
}
