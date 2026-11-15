import { useEffect, useState, type ReactNode } from "react";

import { usePointerOnTable } from "@/lib/pointer-hold";

/**
 * Notices that arrive above a table. While the pointer is on the table, moving,
 * pressed or resting, what was drawn stays as it was, so a notice inserting
 * itself never slides a different row under it. It lands once the pointer has
 * left the table.
 *
 * `signature` names what the notices say, apart from how often they redraw;
 * `onWaiting` hears whether a signature other than the drawn one is held back.
 */
export function HeldWhilePointed({
  children,
  signature = "",
  onWaiting,
}: {
  children: ReactNode;
  signature?: string;
  onWaiting?: (waiting: boolean) => void;
}) {
  const pointed = usePointerOnTable();
  const [held, setHeld] = useState({ children, signature });
  if (!pointed && held.children !== children) setHeld({ children, signature });
  const waiting = pointed && held.signature !== signature;
  useEffect(() => onWaiting?.(waiting), [waiting, onWaiting]);
  return <>{held.children}</>;
}
