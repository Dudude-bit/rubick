import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { Backing } from "@/integrations";
import { behindIt } from "./behind-it";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

const reached: Backing = {
  service: undefined,
  ready: 2,
  draining: 0,
  notReady: 0,
  stop: null,
  doubt: null,
  known: true,
  error: null,
};

describe("what stands behind a backendRef", () => {
  /**
   * The trace above said nobody could settle whether Traefik gets past
   * allow-nginx, and the Rules tab called the same backend "2 ready" in
   * green. Fails if a door nobody settled reads as reached.
   */
  it("says a door nobody settled in neutral, never as ready", () => {
    expect(
      behindIt(
        {
          ...reached,
          doubt: {
            policies: ["allow-nginx"],
            why: "hostNetwork",
            side: "pods",
            client: "Traefik",
            said: null,
          },
        },
        t
      )
    ).toEqual({
      text: "NetworkPolicy allow-nginx decides who may connect to these pods",
      className: "text-fg-mut",
    });
    expect(behindIt(reached, t)).toEqual({
      text: "2 ready",
      className: "text-ok",
    });
  });
});
