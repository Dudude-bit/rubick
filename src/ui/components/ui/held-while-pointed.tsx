import { useState, type ReactNode } from "react";

import { usePointerOnTable } from "@/lib/pointer-hold";

/**
 * Notices that arrive above a table. While a pointer moves over the rows or
 * is pressed on one, what was drawn stays as it was, so a notice inserting
 * itself never slides a different row under the click. It lands once the
 * pointer has been still for a moment or has left the table.
 */
export function HeldWhilePointed({ children }: { children: ReactNode }) {
  const pointed = usePointerOnTable();
  const [held, setHeld] = useState(children);
  if (!pointed && held !== children) setHeld(children);
  return <>{held}</>;
}
