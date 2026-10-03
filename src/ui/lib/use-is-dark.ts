import { useEffect, useState } from "react";

const readIsDark = () => document.documentElement.classList.contains("dark");

/**
 * Whether the canvas is the dark one, read from the class on `<html>`.
 *
 * Not from the theme store: the class is written by an effect in `App`,
 * an ancestor, whose effect runs after a descendant's, so a store
 * subscriber renders one theme behind for a tick. The class also already
 * resolves `system` to what the OS said. The terminal reads its canvas
 * colour the same way (`TerminalImpl`).
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(readIsDark);
  useEffect(() => {
    const sync = () => setDark(readIsDark());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
