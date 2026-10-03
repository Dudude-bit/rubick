import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getAppInfo = vi.fn(async () => ({
  version: "4.19.1",
  name: "Rubick",
  tauriVersion: "2.0.0",
  os: "linux",
}));
vi.mock("@/lib/commands", () => ({
  commands: { getAppInfo: () => getAppInfo() },
}));

import { WhatsNew } from "@/components/layout/WhatsNew";
import { AboutSettings } from "@/components/settings/AboutSettings";
import { useWhatsNewStore } from "@/stores/whatsNewStore";

/**
 * The version lived under `appInfo` for the notes and Settings and under
 * `app-info` for the pod page, so it was asked for twice and a refresh of
 * one copy never reached the other. Fails if either reader keys it apart.
 */
describe("the running version", () => {
  it("is asked for once, however many screens show it", async () => {
    useWhatsNewStore.setState({ seenVersion: "4.19.1", showing: [] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <WhatsNew />
        <AboutSettings />
      </QueryClientProvider>
    );

    expect(await screen.findByText("4.19.1")).toBeInTheDocument();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(getAppInfo).toHaveBeenCalledTimes(1);
  });
});
