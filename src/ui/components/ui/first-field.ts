/**
 * Puts the cursor in the dialog's `data-autofocus` element as it opens: the
 * field the reader must fill or, in a confirmation with none, its Cancel.
 *
 * React's `autoFocus` is not enough: Radix runs a menu item's select inside
 * `flushSync`, so a dialog opened from a row menu mounts while the menu's
 * focus trap is still up, the trap takes the field's focus back, and Radix
 * then focuses its own default (Cancel, in an alert dialog).
 */
export function focusFirstField(event: Event): void {
  const field = (
    event.currentTarget as HTMLElement | null
  )?.querySelector<HTMLElement>("[data-autofocus]");
  if (!field) return;
  event.preventDefault();
  field.focus({ preventScroll: true });
}
