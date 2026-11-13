let held = 0;

/**
 * A dialog that will show a write's answer inline holds the failure toasts
 * for as long as the write is out, so the same refusal is not said twice.
 */
export function holdWriteToasts(): () => void {
  held += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
  };
}

export const writeToastsHeld = (): boolean => held > 0;
