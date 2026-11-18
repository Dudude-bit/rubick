/// <reference lib="webworker" />
import ELK from "elkjs/lib/elk.bundled.js";

import {
  layOut,
  type LayoutAnswer,
  type LayoutRequest,
} from "@/lib/map-layout";

export type { LayoutAnswer, LayoutRequest };

const elk = new ELK();

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";
const each = (value: unknown, is: (item: unknown) => boolean) =>
  value === undefined || (Array.isArray(value) && value.every(is));
const strings = (value: unknown, keys: string[]) =>
  isObject(value) && keys.every((key) => isString(value[key]));
const sized = (value: unknown) =>
  isObject(value) && isNumber(value.width) && isNumber(value.height);
const point = (value: unknown) =>
  isObject(value) && isNumber(value.x) && isNumber(value.y);

const group = (value: unknown) =>
  isObject(value) &&
  isString(value.id) &&
  each(value.nodes, (node) => strings(node, ["id"]) && sized(node)) &&
  each(value.edges, (edge) => strings(edge, ["id", "from", "to"])) &&
  (value.previous === undefined ||
    (isObject(value.previous) && Object.values(value.previous).every(point))) &&
  (value.size === undefined || sized(value.size));

/** Why `data` is not a layout request, or `null` where it is one. */
export function notARequest(data: unknown): string | null {
  if (!isObject(data) || !isNumber(data.id)) return "no request id";
  if (!Array.isArray(data.groups) || !data.groups.every(group))
    return "groups are not what a layout asks for";
  if (
    !each(data.links, (link) =>
      strings(link, ["id", "from", "to", "fromGroup", "toGroup"])
    )
  )
    return "links are not what a layout asks for";
  return null;
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data;
  const wrong = notARequest(data);
  // A message with no id has nobody waiting on it; one with an id is
  // answered, so whoever sent it is not left waiting either.
  if (wrong !== null) {
    if (isObject(data) && isNumber(data.id))
      self.postMessage({
        id: data.id,
        groups: [],
        ms: 0,
        failed: wrong,
      } satisfies LayoutAnswer);
    return;
  }
  const request = data as LayoutRequest;
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
