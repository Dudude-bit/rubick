import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ResourceConnections } from "@/generated/types";
import { connectionsMark } from "./connections-tab";

const t: T = (section, key, values) => translate("en", section, key, values);

const ledger = { kind: "Service", name: "ledger", namespace: "team-blind" };
const unread = (kind: string) => ({
  kind,
  why: { says: "unanswered" as const, version: "v1", said: "forbidden" },
});

const answered = (
  conns: Partial<ResourceConnections>,
  error: Error | null = null
) =>
  ({
    data: {
      subject: ledger,
      edges: [],
      stops: [],
      published: [],
      notLookedAt: [],
      ...conns,
    },
    error,
    isPending: false,
  }) as unknown as ConnectionsQuery;

describe("the Connections tab's mark", () => {
  /**
   * Marco's ledger Service read "Connections 0" over five groups it never
   * looked at. Fails if nothing found among kinds not looked at is a zero,
   * or what was found among them passes for every connection there is.
   */
  it("never counts kinds it did not look at as none", () => {
    const kinds = ["Pod", "Ingress", "PodDisruptionBudget"].map(unread);
    expect(connectionsMark(answered({ notLookedAt: kinds }), t)).toEqual({
      shows: "unchecked",
      says: "3 kinds not looked at",
    });
    const deployment = {
      kind: "Deployment",
      name: "ledger",
      namespace: "team-blind",
    };
    expect(
      connectionsMark(
        answered({
          notLookedAt: kinds,
          edges: [
            {
              from: ledger,
              to: deployment,
              relation: { verb: "selects", selector: "app=ledger" },
            },
          ],
        } as Partial<ResourceConnections>),
        t
      )
    ).toEqual({ shows: "count", of: "1+" });
  });

  /** Fails if a read that failed or is still out wears a number. */
  it("wears no number for a read that failed or has not answered", () => {
    expect(
      connectionsMark(
        { data: undefined, error: new Error("forbidden") } as ConnectionsQuery,
        t
      )
    ).toEqual({
      shows: "unchecked",
      says: "Could not read what connects to this.",
    });
    expect(
      connectionsMark(
        { data: undefined, error: null, isPending: true } as ConnectionsQuery,
        t
      )
    ).toBeUndefined();
    expect(connectionsMark(answered({}), t)).toEqual({
      shows: "count",
      of: 0,
    });
  });
});
