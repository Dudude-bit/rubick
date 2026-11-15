import { describe, expect, it } from "vite-plus/test";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { queryKeys } from "@/lib/query-keys";
import { useAutoscalerPageClears } from "./useAutoscalerPageClears";

const limited = {
  status: {
    conditions: [
      { type: "ScalingLimited", status: "True", reason: "TooManyReplicas" },
    ],
  },
};
const within = {
  status: {
    conditions: [
      { type: "ScalingLimited", status: "False", reason: "DesiredWithinRange" },
    ],
  },
};

const rowFor = (status: "True" | "False") => ({
  rows: [
    {
      autoscaler: {
        kind: "HorizontalPodAutoscaler",
        name: "node",
        namespace: "shop",
        existence: "exists",
        facts: {
          kind: "autoscaler",
          conditions: [
            {
              type: "ScalingLimited",
              status,
              reason: "TooManyReplicas",
              message: null,
              lastTransitionTime: null,
            },
          ],
        },
      },
      target: { kind: "Rollout", name: "node", namespace: "shop" },
    },
  ],
  unread: [],
});

const shell = (list: ReturnType<typeof rowFor>) => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.autoscalers("shop"), list);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const stale = () =>
    client.getQueryState(queryKeys.autoscalers("shop"))?.isInvalidated;
  return { client, wrapper, stale };
};

const page = (
  wrapper: ({ children }: { children: ReactNode }) => ReactNode,
  object: unknown,
  readAt = 1
) =>
  renderHook(
    (props: { object: unknown; readAt: number }) =>
      useAutoscalerPageClears(props.object, props.readAt, "node", "shop"),
    { wrapper, initialProps: { object, readAt } }
  );

describe("an autoscaler page that shows its finding gone", () => {
  /**
   * The shell read the scope's autoscalers once a minute, so the status bar
   * counted a problem for a minute after the page had said it was over.
   * Fails if the page stops asking the list again.
   */
  it("asks the shell's autoscalers again when the shell still holds the finding", () => {
    const { wrapper, stale } = shell(rowFor("True"));
    page(wrapper, within);
    expect(stale()).toBe(true);
  });

  /** Fails if a page that still shows the finding refreshes the shell's list at every poll. */
  it("leaves the list alone while the page shows the finding too", () => {
    const { wrapper, stale } = shell(rowFor("True"));
    page(wrapper, limited);
    expect(stale()).toBe(false);
  });

  /** Fails if every poll of a healthy page re-reads the whole scope. */
  it("leaves the list alone when the shell already agrees", () => {
    const { wrapper, stale } = shell(rowFor("False"));
    page(wrapper, within);
    expect(stale()).toBe(false);
  });

  /** Fails if a page that has not read its object counts as showing nothing. */
  it("does not decide anything before the page has read its conditions", () => {
    const { wrapper, stale } = shell(rowFor("True"));
    page(wrapper, undefined);
    expect(stale()).toBe(false);
  });

  /** Fails if the ask repeats on every poll while the list is still catching up. */
  it("asks once, not on every poll", () => {
    const { client, wrapper, stale } = shell(rowFor("True"));
    const view = page(wrapper, within);
    expect(stale()).toBe(true);
    client.setQueryData(queryKeys.autoscalers("shop"), rowFor("True"));
    expect(stale()).toBe(false);
    view.rerender({ object: { ...within }, readAt: 2 });
    expect(stale()).toBe(false);
  });
});
