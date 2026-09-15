/**
 * The count beside the heading, against the rows under it.
 *
 * The heading used to read `contexts.length` straight off the store while the
 * list drew its own filtered rows — two readers of one fact, which is the
 * shape this project keeps getting bitten by. Nothing failed when they
 * disagreed: the screen simply said "42 contexts" over three rows.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterRecencyStore } from "@/stores/clusterRecencyStore";
import { useClusterStore } from "@/stores/clusterStore";
import type { ContextInfo } from "@/generated/types";

vi.mock("@/lib/commands", () => ({
  commands: {
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigPaths: vi.fn(async () => []),
    getKubeconfigSource: vi.fn(async () => ({
      candidates: [
        { path: "/home/dev/.kube/config", exists: true, origin: "unset" },
      ],
      counts: null,
      error: null,
    })),
    connectionAttempt: vi.fn(async () => ({ proxy: { state: "notTried" } })),
  },
}));

const { ClusterFrontDoor } = await import("./ClusterFrontDoor");

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const context = (name: string): ContextInfo =>
  ({
    name,
    cluster: name,
    user: `${name}-user`,
    namespace: null,
    is_current: false,
    server: `https://${name}.example:6443`,
    exec_command: null,
    auth: { kind: "token", source: null },
  }) as unknown as ContextInfo;

// Four, so "3 of 4" and "4" are different strings.
const NAMES = [
  "prod-eus2-mki",
  "prod-euw1-mki",
  "prod-usc1-mki",
  "dev-euw1-mki",
];

beforeEach(() => {
  localStorage.clear();
  useClusterStore.setState({
    contexts: NAMES.map(context),
    isLoading: false,
    isAuthenticating: false,
    pendingContext: null,
    error: null,
    errorContext: null,
  });
  useClusterRecencyStore.setState({ lastUsed: {} });
  useClusterIdentityStore.setState({ marks: {} });
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClusterFrontDoor />
    </QueryClientProvider>
  );
}

describe("the front door's count", () => {
  it("names every context in the kubeconfig before anything is typed", () => {
    mount();
    expect(
      screen.getByText(new RegExp(t("count", "contexts", { n: 4 })))
    ).toBeInTheDocument();
  });

  /**
   * The guard. Revert the heading to `contexts.length` and it goes on saying
   * "4 contexts" over the three rows the filter left, with every other test
   * in this repo still green.
   */
  it("counts the contexts on screen against the total once the filter narrows the list", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(
      screen.getByRole("textbox", { name: t("action", "filterClusters") }),
      "prod"
    );

    expect(screen.queryAllByRole("option")).toHaveLength(3);
    expect(
      screen.getByText(
        new RegExp(t("count", "contextsMatching", { shown: 3, n: 4 }))
      )
    ).toBeInTheDocument();
  });

  /**
   * Seen on screen before it was fixed: "0 of 93 contexts in your kubeconfig.
   * Pick one to start." The count is still worth saying, but an instruction to
   * pick one of nothing cannot be followed.
   */
  it("stops telling the reader to pick one when the filter has left nothing to pick", async () => {
    const user = userEvent.setup();
    mount();
    expect(
      screen.getByText(new RegExp(t("cluster", "pickOneToStart")))
    ).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: t("action", "filterClusters") }),
      "zzz"
    );

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/0 of 4 contexts/)).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(t("cluster", "pickOneToStart")))
    ).not.toBeInTheDocument();
  });

  /**
   * The plural has to agree with the total, not with the number shown, or a
   * single match reads "1 of 4 context".
   */
  it("keeps the noun plural when one row matches out of many", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(
      screen.getByRole("textbox", { name: t("action", "filterClusters") }),
      "usc1"
    );

    expect(screen.queryAllByRole("option")).toHaveLength(1);
    expect(screen.getByText(/1 of 4 contexts/)).toBeInTheDocument();
  });
});
