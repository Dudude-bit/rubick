import type { ChainStop } from "@/generated/types";

/**
 * What a stop is: a fault; nothing running by intent (the subject is scaled
 * to zero); pods still coming up; or pods nobody could read to say which.
 */
export type StopMood = "fault" | "idle" | "coming" | "unchecked";

/**
 * A selector matching no pod where the Deployments and StatefulSets that
 * could be scaled to zero, or refused their pods, were not read.
 */
export const makersUnread = (stop: ChainStop): boolean =>
  stop.reason === "selectsNothing" && !stop.near && !stop.makersRead;

/** The mood of a stop no subject turns idle. */
export function stopMood(stop: ChainStop): StopMood {
  if (makersUnread(stop)) return "unchecked";
  if (stop.reason === "scaledToZero") return "idle";
  if (stop.reason === "podsBeingMade") return "coming";
  if (stop.reason === "publishesNothingYet")
    return stop.podsUnread ? "unchecked" : "fault";
  if (stop.reason !== "noneReady") return "fault";
  if (stop.why === "comingUp") return "coming";
  return stop.why === "podsUnread" ? "unchecked" : "fault";
}
