import { beforeEach, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const answer = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/commands", () => ({
  commands: { listEvents: () => Promise.resolve(answer.events) },
}));

import type { EventInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";
import { useObjectEvents } from "./useObjectEvents";

const event = (reason: string, uid: string | null): EventInfo => ({
  name: `wd-demo.${reason}`,
  namespace: "lena-sandbox",
  uid: `event-${reason}`,
  type: "Normal",
  reason,
  message: null,
  source: null,
  involvedObject: {
    kind: "Pod",
    name: "wd-demo",
    namespace: "lena-sandbox",
    uid,
  },
  count: 1,
  firstTimestamp: null,
  lastTimestamp: null,
});

beforeEach(() => {
  useWindowActivity.setState({ visible: true });
  answer.events = [
    event("Started", "current"),
    event("Killing", "earlier"),
    event("FailedMount", "earliest"),
    event("Noted", null),
  ];
});

function mount(read: { uid: string } | null) {
  const client = testQueryClient();
  if (read)
    client.setQueryData(
      queryKeys.detail("Pod", "lena-sandbox", "wd-demo"),
      read
    );
  const { result } = renderHook(
    () =>
      useObjectEvents("Pod", "wd-demo", "lena-sandbox", { refresh: "slow" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
  return result;
}

/**
 * Lena's wd-demo, deleted and created twice, listed fifteen events on its
 * page and peek, eleven about the pods before it: a FailedMount for a volume
 * it does not have. Fails if an event naming another uid is kept once the
 * pod has been read, or one that names none is dropped.
 */
it("keeps the events of the incarnation that was read, and those naming none", async () => {
  const result = mount({ uid: "current" });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data?.map((e) => e.reason)).toEqual([
    "Started",
    "Noted",
  ]);
});

/** Fails if events are dropped before the object is read, when which incarnation is meant is not yet known. */
it("keeps every event by name until the object itself is read", async () => {
  const result = mount(null);
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(result.current.data).toHaveLength(4);
});
