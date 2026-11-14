/// <reference lib="webworker" />
import ELK from "elkjs/lib/elk.bundled.js";

import {
  layOut,
  type LayoutAnswer,
  type LayoutRequest,
} from "@/lib/map-layout";

export type { LayoutAnswer, LayoutRequest };

const elk = new ELK();

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  // Always an answer, a failed one included: a throw here posts nothing, and
  // the map would wait on a layout that never comes.
  layOut(elk, request).then(
    (answer) => self.postMessage(answer),
    (error: unknown) => {
      const failed: LayoutAnswer = {
        id: request.id,
        groups: [],
        ms: 0,
        failed: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(failed);
    }
  );
};
