import type { EventInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";

const FAILED_CREATE = "FailedCreate";

const refusedCreate = (event: EventInfo) =>
  event.type === "Warning" && event.reason === FAILED_CREATE;

const at = (time: string | null) => (time ? Date.parse(time) : Number.NaN);

/** When an event was last seen, an undated one before every dated one. */
const seen = (event: EventInfo) => {
  const when = at(event.lastTimestamp);
  return Number.isNaN(when) ? Number.NEGATIVE_INFINITY : when;
};

/** The newest of `events` that `holds`, the later of two seen at once. */
function newestWhere(
  events: readonly EventInfo[],
  holds: (event: EventInfo) => boolean
): EventInfo | null {
  let newest: EventInfo | null = null;
  for (const event of events)
    if (
      refusedCreate(event) &&
      holds(event) &&
      (!newest || seen(event) >= seen(newest))
    )
      newest = event;
  return newest;
}

/**
 * The newest refusal the controller `uid` was given, unless a pod of its was
 * created after it: a refusal a later create got past is history.
 * `create_refusal` answers the Overview in Rust, and
 * `src/contracts/create-refusal-conformance.json` holds the two to one answer.
 */
export function createRefusal(
  uid: string,
  events: readonly EventInfo[],
  created: readonly (string | null)[]
): string | null {
  const newest = newestWhere(
    events,
    (event) => event.involvedObject.uid === uid
  );
  if (!newest) return null;
  const since = at(newest.lastTimestamp);
  return created.some((pod) => at(pod) > since) ? null : (newest.message ?? "");
}

/** The uid of the newest controller of this kind and name a refusal names, for a row that does not carry its own. */
export function refusedUid(
  events: readonly EventInfo[],
  kind: string,
  namespace: string,
  name: string
): string | null {
  const newest = newestWhere(
    events,
    ({ involvedObject: object }) =>
      object.kind === kind &&
      object.name === name &&
      object.namespace === namespace
  );
  return newest?.involvedObject.uid ?? null;
}

const FORBIDDEN = / is forbidden: ([\s\S]+)$/;

/** The part of a refusal that says why, without the name of a pod that never existed; the whole of it where it has no such part. */
export function refusalGist(said: string): string {
  return FORBIDDEN.exec(said)?.[1] ?? said;
}

/** A refusal as a row, the Overview and a shared report say it. */
export const refusalText = (said: string, t: T) =>
  said
    ? t("cause", "podsRefusedSaid", { said: refusalGist(said) })
    : t("cause", "podsRefused");

/** A Job's word with its pods' refusal read beside it; `JobState::refused` answers the same in Rust. */
export const jobWord = (status: string, refused: string | null) =>
  refused !== null && status === "Pending" ? "FailedCreate" : status;
