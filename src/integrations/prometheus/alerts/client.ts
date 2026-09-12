import { commands } from "@/lib/commands";
import type { AlertAbout } from "../../registry";
import { alertsAbout } from "./model";

/** Every alert rule, read once, and the ones about this object picked out. */
export async function alertsAboutObject(input: {
  kind: string;
  name: string;
  namespace: string | null;
}): Promise<AlertAbout[]> {
  return alertsAbout(await commands.prometheusRules(), input);
}
