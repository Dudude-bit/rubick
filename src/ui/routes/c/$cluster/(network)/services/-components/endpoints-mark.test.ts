import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ConnectionsRead } from "@/hooks/useConnections";
import type { ObjectRef, ServicePublished } from "@/generated/types";
import { endpointsMark } from "./endpoints-mark";

const t: T = (section, key, values) => translate("en", section, key, values);

const ledger = {
  kind: "Service",
  name: "ledger",
  namespace: "team-blind",
  existence: "present",
  facts: null,
} as ObjectRef;

const notReady: ServicePublished = {
  service: ledger,
  source: "slices",
  slices: 1,
  ready: 0,
  draining: 0,
  notReady: 1,
  unrouted: 0,
  unroutedReady: 0,
  ports: [],
  endpoints: [
    {
      address: "10.42.1.27",
      target: { ...ledger, kind: "Pod", name: "ledger-76bccd5b44-499fh" },
      ready: false,
      serving: false,
      terminating: false,
      nodeName: "k3d-rubick-live-agent-0",
      zone: null,
      hintZones: [],
      ports: [8080],
    },
  ],
  whole: true,
  unpublished: [],
  stop: null,
};

const read = (published: ServicePublished[]) =>
  ({
    data: {
      subject: ledger,
      edges: [],
      stops: [],
      published,
      notLookedAt: [],
    },
    error: null,
    isPending: false,
  }) as unknown as ConnectionsRead;

describe("the Endpoints tab's mark", () => {
  /**
   * Marco's ledger: "Endpoints 0" over a tab listing its one endpoint, not
   * ready. Fails if the mark counts only the ready ones the tab does not
   * limit itself to.
   */
  it("counts every endpoint the tab lists, ready or not", () => {
    expect(endpointsMark(read([notReady]), t)).toEqual({
      shows: "count",
      of: 1,
    });
  });

  /** Fails if a read still out, failed, or silent about this Service wears a number. */
  it("wears no number for what it has not read", () => {
    expect(
      endpointsMark(
        { data: undefined, error: null, isPending: true } as ConnectionsRead,
        t
      )
    ).toBeUndefined();
    expect(
      endpointsMark(
        { data: undefined, error: new Error("forbidden") } as ConnectionsRead,
        t
      )
    ).toEqual({
      shows: "unchecked",
      says: "Could not read what this Service publishes.",
    });
    expect(endpointsMark(read([]), t)).toBeUndefined();
  });
});
