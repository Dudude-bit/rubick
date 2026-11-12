import { describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import { useParams } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";

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

import { useResourceDetail } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { renderWithRouter } from "@/test/render";
import { marcoReview } from "@/test/marco";
import { useClusterStore } from "@/stores/clusterStore";
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
    const { client } = await renderWithRouter(<ConfigMapDetail />, {
      at: "/c/prod/configmaps/prod/app",
      route: "/c/$cluster/configmaps/$namespace/$name",
    });

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

/** The page of whichever ConfigMap the address names, as the real hook reads it. */
function pageOfTheAddress() {
  vi.mocked(useResourceDetail).mockImplementation((() => {
    const { namespace, name } = useParams({ strict: false });
    return {
      name,
      namespace,
      resource: {
        name,
        namespace,
        dataKeys: ["config.yaml"],
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
    };
  }) as unknown as typeof useResourceDetail);
  command("getConfigmapData").mockImplementation(async (_name, namespace) => ({
    values: { "config.yaml": `text of ${namespace}` },
    withheld: {},
    binary: {},
  }));
}

describe("a ConfigMap page moved to another ConfigMap", () => {
  /**
   * An editor left open on prod/app-config stayed open when the palette
   * moved the page to staging/app-config, still holding prod's text, and
   * Save wrote it into staging's key. Fails if anything a reader began on
   * one object is still there on the next: the page is the same component
   * at the same route, and nothing else ends it.
   */
  it("starts over, so an edit begun on one is not saved into the other", async () => {
    pageOfTheAddress();
    command("setConfigmapKey").mockClear();
    const { router } = await renderWithRouter(<ConfigMapDetail />, {
      at: "/c/k/configmaps/prod/app-config",
      route: "/c/$cluster/configmaps/$namespace/$name",
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Value of config.yaml" })
    );
    const field = screen.getByRole("textbox", { name: "Value of config.yaml" });
    expect(field).toHaveValue("text of prod");
    await user.type(field, " edited");

    await act(() =>
      router.navigate({ href: "/c/k/configmaps/staging/app-config" })
    );
    await waitFor(() =>
      expect(command("getConfigmapData")).toHaveBeenCalledWith(
        "app-config",
        "staging"
      )
    );

    expect(
      screen.queryByRole("textbox", { name: "Value of config.yaml" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(await screen.findByText("text of staging")).toBeInTheDocument();
    expect(command("setConfigmapKey")).not.toHaveBeenCalled();
  });
});

function marcosPage(activeTab: string) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "checkout-config",
    namespace: "team-checkout",
    resource: {
      name: "checkout-config",
      namespace: "team-checkout",
      dataKeys: ["LOG_LEVEL"],
      labels: {},
      annotations: {},
    },
    isLoading: false,
    error: null,
    yaml: undefined,
    copyYaml: vi.fn(),
    activeTab,
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  command("getConfigmapData").mockResolvedValue({
    values: { LOG_LEVEL: "info" },
    withheld: {},
    binary: {},
  });
  command("checkAccess").mockImplementation(marcoReview);
  useClusterStore.setState((s) => ({
    currentContext: "acme-staging",
    isConnected: true,
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
  return renderWithRouter(<ConfigMapDetail />, {
    at: "/c/acme-staging/configmaps/team-checkout/checkout-config",
    route: "/c/$cluster/configmaps/$namespace/$name",
  });
}

describe("Marco's ConfigMap, which his Role lets him read and not change", () => {
  /**
   * Marco opened checkout-config and every key offered an Edit whose Save
   * the cluster refuses. Fails if a key's Edit is runnable or opens the
   * editor while can-i patch configmaps says no.
   */
  it("greys each key's Edit with the can-i question and opens no editor", async () => {
    await marcosPage("data");
    const edit = () =>
      screen.getByRole("button", { name: "Value of LOG_LEVEL" });
    await waitFor(() =>
      expect(edit()).toHaveAttribute("aria-disabled", "true")
    );

    const user = userEvent.setup();
    await user.hover(edit());
    expect(
      (
        await screen.findAllByText(
          /can-i patch configmaps\/checkout-config -n team-checkout/
        )
      ).length
    ).toBeGreaterThan(0);
    await user.click(edit());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  /**
   * The header's greyed Delete said why in a tooltip drawn inside the page,
   * whose transformed, scrolling box cut its first line under the tab strip.
   * Fails if the reason is drawn anywhere inside the page.
   */
  it("says why Delete is greyed in a tooltip outside the page's box", async () => {
    const { container } = await marcosPage("data");
    const remove = () => screen.getByRole("button", { name: "Delete" });
    await waitFor(() =>
      expect(remove()).toHaveAttribute("aria-disabled", "true")
    );

    await userEvent.setup().hover(remove());
    const reasons = await screen.findAllByText(
      /can-i delete configmaps\/checkout-config -n team-checkout/
    );
    for (const reason of reasons) {
      expect(container.contains(reason)).toBe(false);
      expect(document.body.contains(reason)).toBe(true);
    }
  });

  /** Fails if the YAML tab offers Edit YAML, whose Apply the cluster refuses. */
  it("greys Edit YAML with the same question", async () => {
    await marcosPage("yaml");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit YAML" })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
  });
});
