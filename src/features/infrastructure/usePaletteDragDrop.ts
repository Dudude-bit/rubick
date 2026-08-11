import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { ResourceKind } from "./types";

interface UsePaletteDragDropArgs {
  reactFlowWrapper: RefObject<HTMLDivElement | null>;
  toFlowPosition: (point: { x: number; y: number }) => {
    x: number;
    y: number;
  };
  addResource: (
    kind: ResourceKind,
    position: { x: number; y: number },
    namespace: string
  ) => unknown;
  currentNamespace: string | null | undefined;
}

interface UsePaletteDragDropResult {
  /** Pointer-down on a palette item — starts the drag-or-click gesture. */
  handlePalettePointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    kind: ResourceKind
  ) => void;
  /** True if the most recent pointer-up had moved (i.e. was a drag, not a
   *  click). The palette's onClick reads this to suppress the click that
   *  the OS fires after a drag-release. */
  suppressClickRef: RefObject<boolean>;
}

const DRAG_THRESHOLD_PX = 6;

/**
 * Pointer-down on a palette item starts a "maybe-drag" gesture: a ghost
 * element follows the cursor, and pointer-up either fires `addResource`
 * at the drop position (if pointer moved past the threshold and landed
 * inside the canvas) or falls through to the palette's onClick handler
 * (the click → centre-of-canvas spawn).
 *
 * Refs (`dragGhostRef`, `dragStateRef`, `suppressClickRef`) are owned
 * by this hook so the page never reaches into them directly. The
 * cleanup effect runs on unmount and removes any in-flight listeners
 * + ghost element so navigating away mid-drag doesn't leak them.
 */
export function usePaletteDragDrop({
  reactFlowWrapper,
  toFlowPosition,
  addResource,
  currentNamespace,
}: UsePaletteDragDropArgs): UsePaletteDragDropResult {
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    kind: ResourceKind;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const state = dragStateRef.current;
    if (!state) {
      return;
    }
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    if (!state.moved && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD_PX) {
      state.moved = true;
    }
    if (dragGhostRef.current) {
      dragGhostRef.current.style.left = `${event.clientX + 12}px`;
      dragGhostRef.current.style.top = `${event.clientY + 12}px`;
    }
  }, []);

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current;
      window.removeEventListener("pointermove", handlePointerMove);
      // `handlePointerUp` references itself for listener cleanup.
      // Trips react-hooks/immutability's "accessed before declared"
      // check; the runtime closure semantics are correct (the const
      // exists by the time the listener fires).
      // eslint-disable-next-line react-hooks/immutability
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";

      if (state && state.moved && reactFlowWrapper.current) {
        const bounds = reactFlowWrapper.current.getBoundingClientRect();
        const inside =
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom;
        if (inside) {
          const position = toFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });
          addResource(state.kind, position, currentNamespace || "default");
        }
      }

      suppressClickRef.current = state?.moved ?? false;
      if (dragGhostRef.current) {
        dragGhostRef.current.remove();
        dragGhostRef.current = null;
      }
      dragStateRef.current = null;
    },
    [
      addResource,
      currentNamespace,
      handlePointerMove,
      reactFlowWrapper,
      toFlowPosition,
    ]
  );

  const handlePalettePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, kind: ResourceKind) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      dragStateRef.current = {
        kind,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      suppressClickRef.current = false;
      if (!dragGhostRef.current) {
        const ghost = document.createElement("div");
        ghost.className =
          "pointer-events-none fixed z-[9999] -translate-x-1/2 -translate-y-1/2 rounded-md border border-hair bg-raise px-3 py-1.5 text-xs font-semibold shadow-md";
        ghost.textContent = kind;
        ghost.style.left = `${event.clientX + 12}px`;
        ghost.style.top = `${event.clientY + 12}px`;
        document.body.appendChild(ghost);
        dragGhostRef.current = ghost;
      } else {
        dragGhostRef.current.textContent = kind;
        dragGhostRef.current.style.left = `${event.clientX + 12}px`;
        dragGhostRef.current.style.top = `${event.clientY + 12}px`;
      }
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [handlePointerMove, handlePointerUp]
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (dragGhostRef.current) {
        dragGhostRef.current.remove();
        dragGhostRef.current = null;
      }
    };
  }, [handlePointerMove, handlePointerUp]);

  return { handlePalettePointerDown, suppressClickRef };
}
