import { useEffect } from "react";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { listenEvent } from "@/lib/events";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";

/**
 * Keeps the store on the backend's list: every change arrives as the whole
 * list, and the first read covers whatever opened before the window did.
 */
export function useTerminalSessionSync(): void {
  useEffect(() => {
    let live = true;
    let heard = false;
    const { replace, fail } = useTerminalSessionStore.getState();
    const off = listenEvent("terminal-sessions", (event) => {
      heard = true;
      replace(event.payload.sessions);
    });
    void off
      .catch(() => undefined)
      .then(() => commands.listTerminalSessions())
      .then(
        (sessions) => {
          if (live && !heard) replace(sessions);
        },
        (error: unknown) => {
          if (live && !heard) fail(errorToShow(error));
        }
      );
    return () => {
      live = false;
      void off.then(
        (unlisten) => unlisten(),
        () => undefined
      );
    };
  }, []);
}
