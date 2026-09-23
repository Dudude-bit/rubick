import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

/** Every command answers nothing unless a test says otherwise. */
const command = vi.hoisted(() => {
  const made = new Map<string, ReturnType<typeof vi.fn>>();
  return (name: string) => {
    const known = made.get(name) ?? vi.fn(async () => null);
    made.set(name, known);
    return known;
  };
});
vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: (_, name) => command(String(name)) }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useResourceDetail } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { ConfigMapDetail } from "./ConfigMapDetail";

/**
 * The page read its values under `[name, namespace]` and a pod's environment
 * under `[namespace, name]`, so a key edited here never reached the pod —
 * and a ConfigMap `app` in `prod` shared an entry with one `prod` in `app`.
 * Fails if the page reads or invalidates the values anywhere but where the
 * environment and the peek's Data tab keep them.
 */
describe("a ConfigMap's values on its page", () => {
  it("are read and re-read where every other reader keeps them", async () => {
    vi.mocked(useResourceDetail).mockReturnValue({
      name: "app",
      namespace: "prod",
      resource: {
        name: "app",
        namespace: "prod",
        dataKeys: ["LOG_LEVEL"],
        labels: {},
        annotations: {},
      },
      isLoading: false,
      error: null,
      yaml: "",
      copyYaml: vi.fn(),
      activeTab: "data",
      setActiveTab: vi.fn(),
      goBack: vi.fn(),
      refetch: vi.fn(),
      deleteMutation: { mutate: vi.fn(), isPending: false },
    } as unknown as ReturnType<typeof useResourceDetail>);
    command("getConfigmapData").mockResolvedValue({
      values: { LOG_LEVEL: "debug" },
      withheld: {},
      binary: {},
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider>
            <ConfigMapDetail />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(
        client.getQueryData(queryKeys.configMapData("prod", "app"))
      ).toBeDefined()
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Value of LOG_LEVEL" })
    );
    const field = screen.getByRole("textbox", { name: "Value of LOG_LEVEL" });
    await user.clear(field);
    await user.type(field, "info");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(command("getConfigmapData")).toHaveBeenCalledTimes(2)
    );
  });
});
