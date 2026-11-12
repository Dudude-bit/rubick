/**
 * The control a click on a row landed in, which keeps the click. A trigger
 * that only shows a tooltip is not one, so the row takes it.
 */
export function controlAt(target: HTMLElement): HTMLElement | null {
  const controls = 'button, a, [role="menuitem"], [data-quick-actions]';
  let at = target.closest<HTMLElement>(controls);
  while (at?.hasAttribute("data-tooltip-only"))
    at = at.parentElement?.closest<HTMLElement>(controls) ?? null;
  return at;
}
