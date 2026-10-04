import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { EventPayload, Transport } from "./index";

/** Tauri IPC: always reachable, since the backend lives in this process. */
export function ipcTransport(): Transport {
  return {
    kind: "ipc",
    invoke: (command, args) => invoke(command, args),
    listen: (channel, onEvent) =>
      listen<EventPayload<typeof channel>>(channel, (event) =>
        onEvent(event.payload)
      ),
    status: () => "open",
    onStatus: () => () => {},
  };
}
