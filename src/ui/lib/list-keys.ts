/**
 * The list on screen, for keys pressed while the focus is not in it.
 *
 * The page's table registers here and the central handler in `useShortcuts`
 * hands it whatever the chords and the page keys did not take, so a list
 * answers the arrows from the moment it is on screen rather than once a row
 * has been clicked or tabbed into. The latest claim wins: a page mounting
 * over another is the one being read.
 */
type ListKeyHandler = (event: KeyboardEvent) => boolean;

const claims: ListKeyHandler[] = [];

export function claimListKeys(handler: ListKeyHandler): () => void {
  claims.push(handler);
  return () => {
    const at = claims.lastIndexOf(handler);
    if (at >= 0) claims.splice(at, 1);
  };
}

/** Whether the list took the key. A key a row already handled is not offered. */
export function routeListKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  return claims.at(-1)?.(event) ?? false;
}
