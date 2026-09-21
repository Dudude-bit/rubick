import { commands } from "@/lib/commands";
import type { AlertAbout } from "../../registry";
import { alertsAbout, speaksOf } from "./model";

type Rules = Awaited<ReturnType<typeof commands.prometheusRules>>;

/** Every alert rule, read once per cluster, and sliced per object. */
export const alertsAboutObject = {
  read: () => commands.prometheusRules(),
  speaksOf,
  pick: (
    read: unknown,
    input: { kind: string; name: string; namespace: string | null }
  ): AlertAbout[] => alertsAbout(read as Rules, input),
};
