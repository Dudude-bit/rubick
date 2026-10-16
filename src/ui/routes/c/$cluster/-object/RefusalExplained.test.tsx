import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({
  commands: { getNamespace: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { RefusalExplained } from "./RefusalExplained";

const RESTRICTED =
  'Error creating: pods "root-web-d786dc494-8fv4j" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "sleeper" must set securityContext.allowPrivilegeEscalation=false), unrestricted capabilities (container "sleeper" must set securityContext.capabilities.drop=["ALL"]), runAsNonRoot != true (pod or container "sleeper" must set securityContext.runAsNonRoot=true), seccompProfile (pod or container "sleeper" must set securityContext.seccompProfile.type to "RuntimeDefault" or "Localhost")';

const QUOTA =
  'Error creating: pods "capped-6d67bcbdbc-2w7j5" is forbidden: exceeded quota: two-pods, requested: pods=1, used: pods=2, limited: pods=2';

const namespaceWith = (labels: Record<string, string>) => ({
  name: "refused-demo",
  uid: "ns",
  status: "Active",
  labels,
  createdAt: null,
});

const show = (said: string) =>
  renderWithRouter(<RefusalExplained said={said} namespace="refused-demo" />);

describe("RefusalExplained", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
  });
  afterEach(() => vi.mocked(commands.getNamespace).mockReset());

  /**
   * Live, root-web's page quoted four lines of PodSecurity at its reader.
   * Fails if the page stops naming the label that sets the level, or a check
   * loses how to pass it or the paint on the code in it.
   */
  it("names the namespace label that enforces the level and lists each failed check with how to pass it", async () => {
    vi.mocked(commands.getNamespace).mockResolvedValue(
      namespaceWith({ "pod-security.kubernetes.io/enforce": "restricted" })
    );
    await show(RESTRICTED);
    const line = screen.getByTestId("refused-line");
    await waitFor(() =>
      expect(line).toHaveTextContent(
        "The API server refuses to create its pods. The namespace Namespace refused-demo enforces the Pod Security level restricted through its label pod-security.kubernetes.io/enforce, and this template fails 4 of its checks:"
      )
    );
    const rows = within(screen.getByTestId("refusal-rows"));
    const how = rows.getByText("unrestricted capabilities").nextElementSibling;
    expect(how).toHaveTextContent(
      'container "sleeper" must set securityContext.capabilities.drop=["ALL"]'
    );
    const code = within(how as HTMLElement);
    expect(code.getByText("securityContext.capabilities.drop")).toHaveClass(
      "font-medium"
    );
    expect(code.getByText('"ALL"')).toHaveClass("text-syn-scalar");
    expect(line).toHaveTextContent(
      "Set these in the pod template, or have the namespace's Pod Security level lowered."
    );
  });

  /** A namespace with no label of its own is held to the cluster's default; fails if that is blamed on a label it does not have. */
  it("says the cluster's default applies where the namespace sets no level", async () => {
    vi.mocked(commands.getNamespace).mockResolvedValue(namespaceWith({}));
    await show(RESTRICTED);
    await waitFor(() =>
      expect(screen.getByTestId("refused-line")).toHaveTextContent(
        "The namespace Namespace refused-demo sets no Pod Security level, so the cluster's default restricted applies"
      )
    );
  });

  /**
   * A namespace that could not be read is not one without a label. Fails if
   * an unread namespace is said to set no level, or to set one.
   */
  it("names neither the label nor the default where the namespace could not be read", async () => {
    vi.mocked(commands.getNamespace).mockRejectedValue(
      new Error("namespaces is forbidden")
    );
    await show(RESTRICTED);
    await waitFor(() =>
      expect(commands.getNamespace).toHaveBeenCalledWith("refused-demo")
    );
    const line = screen.getByTestId("refused-line");
    expect(line).toHaveTextContent(
      "Pod Security admission enforces the level restricted on the namespace Namespace refused-demo, and this template fails 4 of its checks:"
    );
    expect(line).not.toHaveTextContent("through its label");
    expect(line).not.toHaveTextContent("default");
  });

  /** Fails if a full quota stops linking the quota, or a row loses what is used and asked. */
  it("links the full quota and says what is used and what one more pod needs", async () => {
    await show(QUOTA);
    const line = screen.getByTestId("refused-line");
    expect(line).toHaveTextContent(
      "The ResourceQuota ResourceQuota two-pods has no room left in this namespace for another pod:"
    );
    expect(
      screen.getByRole("link", { name: "ResourceQuota two-pods" })
    ).toHaveAttribute("href", "/c/test/resourcequotas/refused-demo/two-pods");
    expect(
      within(screen.getByTestId("refusal-rows")).getByText(
        "2 of 2 in use, one more pod needs 1"
      )
    ).toBeInTheDocument();
    expect(commands.getNamespace).not.toHaveBeenCalled();
  });

  /** Live, the Service ran on from the quoted error as one sentence. Fails if an unreachable webhook stops pointing at the Service it calls, on a line of its own. */
  it("points an unreachable webhook at the Service behind it", async () => {
    await show(
      'Error creating: Internal error occurred: failed calling webhook "pods.guard.example.com": failed to call webhook: Post "https://guard.refused-hook.svc:443/validate?timeout=10s": service "guard" not found'
    );
    const service = screen.getByRole("link", { name: "Service guard" });
    expect(service.closest("p")?.textContent).toMatch(
      /^The webhook is served by the Service .*guard in the namespace .*refused-hook\.$/
    );
    expect(service).toHaveAttribute(
      "href",
      "/c/test/services/refused-hook/guard"
    );
  });

  /** An answer this does not know is quoted whole, not guessed at. */
  it("quotes an answer of a shape it does not know", async () => {
    const said = 'pods "web-1" is forbidden: node "a" not ready';
    await show(said);
    expect(screen.getByTestId("refused-line")).toHaveTextContent(
      `The API server refuses to create its pods. The API server answered: ${said}`
    );
    expect(screen.queryByText("What the API server said")).toBeNull();
  });
});
