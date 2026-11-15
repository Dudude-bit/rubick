import { useState, type ReactNode } from "react";

import { usePointerOnTable } from "@/lib/pointer-hold";

/**
 * Notices that arrive above a table. While the pointer is on the table, moving,
 * pressed or resting, what was drawn stays as it was, so a notice inserting
 * itself never slides a different row under it. It lands once the pointer has
 * left the table.
 */
export function HeldWhilePointed({ children }: { children: ReactNode }) {
  const pointed = usePointerOnTable();
  const [held, setHeld] = useState(children);
  if (!pointed && held !== children) setHeld(children);
  return <>{held}</>;
}
