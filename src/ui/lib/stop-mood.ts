import type { ChainStop } from "@/generated/types";

/**
 * What a stop is: a fault; nothing running by intent (the subject is scaled
 * to zero); pods still coming up; or pods nobody could read to say which.
 */
export type StopMood = "fault" | "idle" | "coming" | "unchecked";

/** The mood of a stop no subject turns idle. */
export function stopMood(stop: ChainStop): StopMood {
  if (stop.reason === "scaledToZero") return "idle";
  if (stop.reason === "podsBeingMade") return "coming";
  if (stop.reason === "publishesNothingYet")
    return stop.podsUnread ? "unchecked" : "fault";
  if (stop.reason !== "noneReady") return "fault";
  if (stop.why === "comingUp") return "coming";
  return stop.why === "podsUnread" ? "unchecked" : "fault";
}
