import {
  Ban,
  KeyRound,
  SearchX,
  ShieldX,
  SquareTerminal,
  TimerOff,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

import type { ConnectFailure } from "@/generated/types";
import type { T } from "@/i18n/useT";

/** What the screen leads with for each kind of failure, as a total map. */
export const FAILURE: Record<
  ConnectFailure,
  {
    icon: LucideIcon;
    title: "didNotAnswer" | "couldNotConnect";
    line:
      | "failDns"
      | "failRefused"
      | "failTimeout"
      | "failTls"
      | "failCredentials"
      | "failSignIn"
      | "notReachable";
  }
> = {
  dns: { icon: SearchX, title: "couldNotConnect", line: "failDns" },
  refused: { icon: Ban, title: "couldNotConnect", line: "failRefused" },
  timeout: { icon: TimerOff, title: "didNotAnswer", line: "failTimeout" },
  tls: { icon: ShieldX, title: "couldNotConnect", line: "failTls" },
  credentials: {
    icon: KeyRound,
    title: "couldNotConnect",
    line: "failCredentials",
  },
  signIn: {
    icon: SquareTerminal,
    title: "couldNotConnect",
    line: "failSignIn",
  },
  unknown: { icon: WifiOff, title: "didNotAnswer", line: "notReachable" },
};

/** The server's host and port, which name the machine without a path. */
function hostOf(server: string | null | undefined): string | null {
  if (!server) return null;
  try {
    return new URL(server).host || null;
  } catch {
    return null;
  }
}

/** The program a credential plugin runs, without the directory it lives in. */
function pluginOf(command: string | null | undefined): string | null {
  const program = command?.trim().split(/\s+/)[0];
  return program ? (program.split(/[\\/]/).pop() ?? null) : null;
}

export function failureLine(
  t: T,
  failure: ConnectFailure,
  context: string,
  server: string | null | undefined,
  exec: string | null | undefined
): string {
  const host = hostOf(server) ?? context;
  if (failure === "signIn") {
    const plugin = pluginOf(exec);
    return plugin
      ? t("cluster", "failPlugin", { plugin })
      : t("cluster", "failSignIn");
  }
  return t("cluster", FAILURE[failure].line, { host, context });
}
