import { useCallback, useState, useRef } from "react";

/** Keyboard action mapping: key -> callback */
export interface KeyboardAction {
  /** Keyboard key (single character or key name) */
  key: string;
  /** Callback when key is pressed */
  onAction: (rowIndex: number) => void;
  /** Description for help text */
  label?: string;
}

interface UseTableKeyboardNavOptions {
  /** Total number of rows */
  rowCount: number;
  /** Whether keyboard navigation is enabled */
  enabled?: boolean;
  /** Custom keyboard actions */
  keyboardActions?: KeyboardAction[];
}

interface UseTableKeyboardNavReturn {
  /** Ref for the table container */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Currently focused row index (-1 if none) */
  focusedRowIndex: number;
  /** Set focused row index */
  setFocusedRowIndex: (index: number) => void;
  /** Props to spread on each row */
  getRowProps: (index: number) => {
    tabIndex: number;
    "data-row-index": number;
    "data-focused": boolean;
    onFocus: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

export function useTableKeyboardNav({
  rowCount,
  enabled = true,
  keyboardActions = [],
}: UseTableKeyboardNavOptions): UseTableKeyboardNavReturn {
  const [rawFocusedRowIndex, setFocusedRowIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clamp the stored index to the current row count at *read* time
  // rather than syncing via a useEffect → setState dance. The effect
  // form fired `set-state-in-effect`, caused a cascading render every
  // time `rowCount` shrank, and was load-bearing only for keeping the
  // exposed value in range. Derived state has no such hazard.
  const focusedRowIndex =
    rawFocusedRowIndex >= rowCount
      ? rowCount > 0
        ? rowCount - 1
        : -1
      : rawFocusedRowIndex;

  const focusRow = useCallback(
    (index: number) => {
      if (index < 0 || index >= rowCount) return;

      const rowElement = containerRef.current?.querySelector(
        `[data-row-index="${index}"]`
      ) as HTMLElement;

      if (rowElement) {
        rowElement.focus();
        setFocusedRowIndex(index);
      }
    },
    [rowCount]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      if (!enabled) return;

      // Check custom keyboard actions first
      const customAction = keyboardActions.find(
        (action) => action.key.toLowerCase() === e.key.toLowerCase()
      );
      if (customAction) {
        e.preventDefault();
        customAction.onAction(currentIndex);
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (currentIndex < rowCount - 1) {
            focusRow(currentIndex + 1);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (currentIndex > 0) {
            focusRow(currentIndex - 1);
          }
          break;
        // Enter is deliberately absent: activating a row is the same gesture
        // as clicking it, modifiers and all, so the row owns it.
        case "Home":
          e.preventDefault();
          focusRow(0);
          break;
        case "End":
          e.preventDefault();
          focusRow(rowCount - 1);
          break;
        case "Escape":
          e.preventDefault();
          setFocusedRowIndex(-1);
          (e.target as HTMLElement).blur();
          break;
      }
    },
    [enabled, rowCount, focusRow, keyboardActions]
  );

  const getRowProps = useCallback(
    (index: number) => ({
      tabIndex:
        focusedRowIndex === index || (focusedRowIndex === -1 && index === 0)
          ? 0
          : -1,
      "data-row-index": index,
      "data-focused": focusedRowIndex === index,
      onFocus: () => setFocusedRowIndex(index),
      onKeyDown: (e: React.KeyboardEvent) => handleKeyDown(e, index),
    }),
    [focusedRowIndex, handleKeyDown]
  );

  return {
    containerRef,
    focusedRowIndex,
    setFocusedRowIndex,
    getRowProps,
  };
}
