import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";

import type { AuditPage, AuditQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";

type Heard = (event: {
  payload: { context: string; revision: number };
}) => void;
const heard = new Set<Heard>();
let asked = 0;

vi.mock("@/lib/events", () => ({
  listenEvent: (_channel: string, handler: Heard) => {
    heard.add(handler);
    return Promise.resolve(() => heard.delete(handler));
  },
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getAudit: (): Promise<AuditPage> => {
      asked += 1;
      return Promise.reject(new Error("not needed here"));
    },
  },
}));

const { useAuditPage } = await import("./useAudit");

const query: AuditQuery = {
  by: "rule",
  categories: [],
  severities: [],
  rules: [],
  system: false,
  offset: 0,
};

function Page() {
  useAuditPage(query);
  return null;
}

const announce = () =>
  act(() => {
    for (const handler of heard)
      handler({ payload: { context: "prod", revision: 2 } });
  });

beforeEach(() => {
  asked = 0;
  heard.clear();
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    namespaceScope: [],
  });
  useWindowActivity.setState({ visible: true });
});

describe("the Audit page's reads", () => {
  /**
   * Each read keeps Audit's watches and upgrade passes alive. Fails if a
   * minimised window goes on reading at every change it is told of, which
   * kept them running for nobody.
   */
  it("are not asked again for changes while the window is hidden", async () => {
    await renderWithRouter(<Page />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    await waitFor(() => expect(heard.size).toBe(1));
    const first = asked;
    await announce();
    await waitFor(() => expect(asked).toBeGreaterThan(first));

    act(() => useWindowActivity.setState({ visible: false }));
    const hidden = asked;
    await announce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(hidden);
  });
});
