import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { WITHHELD_MARKER } from "@/lib/withheld";
import { renderWithProviders } from "@/test/render";
import { YamlTabContent } from "./YamlTabContent";

const manifest = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/lib/commands", () => ({
  commands: {
    getManifest: manifest.read,
    forgetDiscovery: () => Promise.resolve(),
  },
}));

vi.mock("../-yaml", () => ({
  YamlEditor: ({ value }: { value: string }) => (
    <pre data-testid="yaml-editor">{value}</pre>
  ),
  YamlEditorAction: () => null,
}));

const APPLIABLE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-billing
  namespace: platform
spec:
  replicas: 2
`;

const RECORD = JSON.stringify({
  kind: "ConfigMap",
  data: { "nginx.conf": "worker_processes 2;", "server.key": WITHHELD_MARKER },
});
const APPLIED = `apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx
  namespace: team-a
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: '${RECORD}'
data:
  nginx.conf: worker_processes 2;
  server.key: '${WITHHELD_MARKER}'
`;

describe("the YAML tab", () => {
  /**
   * The record kubectl keeps of a ConfigMap is drawn with its private key
   * blanked, and opened it read as though kubectl had recorded the
   * placeholder. Fails if the tab stops saying the app blanked it and which
   * annotation, or says it of a manifest with no blanked record.
   */
  it("says which annotation holds a record the app blanked a key in", async () => {
    const { unmount } = renderWithProviders(
      <YamlTabContent yaml={APPLIED} onCopy={() => {}} />
    );
    expect(await screen.findByRole("note")).toHaveTextContent(
      /^Withheld inside kubectl\.kubernetes\.io\/last-applied-configuration: server\.key\. The annotation on the cluster is untouched/
    );
    unmount();

    renderWithProviders(<YamlTabContent yaml={APPLIABLE} onCopy={() => {}} />);
    await screen.findByTestId("yaml-editor");
    expect(screen.queryByRole("note")).toBeNull();
  });

  /**
   * A Helm release's manifest is not an object's YAML: the backend says what
   * it withheld in which document. Fails if the tab does not draw what it is
   * told, or reads the text for blanked annotations beside it.
   */
  it("draws what it is told was withheld, in place of its own reading", async () => {
    const told = "Withheld in Secret web-key: tls.key.";
    renderWithProviders(
      <YamlTabContent yaml={APPLIED} withheld={[told]} onCopy={() => {}} />
    );

    await screen.findByTestId("yaml-editor");
    expect(screen.getByRole("note")).toHaveTextContent(told);
  });

  /**
   * Sam read "the object as the API server has it" above a Deployment with no
   * status, uid or finalizers. Fails if the note claims the object as served.
   */
  it("says the manifest is the object as you would apply it, and names what is left out", async () => {
    renderWithProviders(<YamlTabContent yaml={APPLIABLE} onCopy={() => {}} />);

    await screen.findByTestId("yaml-editor");
    const note = screen.getByText(/as you would apply it/);
    expect(note.textContent).not.toMatch(/API server has it/);
    for (const field of ["status", "ownerReferences", "finalizers"]) {
      expect(note.textContent).toContain(field);
    }
  });

  /**
   * At 1000 wide Lena's YAML header broke "Изменить YAML" onto two lines
   * beside a wrapped note. Fails if an action's label can break, or the
   * actions give up their width to the note instead of the note wrapping.
   */
  it("keeps the actions on one line and lets the note wrap beside them", async () => {
    renderWithProviders(<YamlTabContent yaml={APPLIABLE} onCopy={() => {}} />);

    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy).toHaveClass("whitespace-nowrap");
    expect(copy.parentElement).toHaveClass("flex-none");
    expect(screen.getByText(/as you would apply it/)).toHaveClass("min-w-0");
  });

  /**
   * A manifest that was refused or failed drew as a skeleton with Copy
   * disabled for ever. Fails if the tab says nothing of the failed read, draws
   * the editor, or offers no way to ask again.
   */
  it("says the manifest could not be read and asks again on request", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <YamlTabContent
        yaml={undefined}
        error={new Error("etcd timeout")}
        onRetry={onRetry}
        onCopy={() => {}}
      />
    );

    expect(
      await screen.findByText("Could not read the manifest")
    ).toBeInTheDocument();
    expect(screen.getByText(/etcd timeout/)).toBeInTheDocument();
    expect(screen.queryByTestId("yaml-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    expect(onRetry).toHaveBeenCalled();
  });

  /**
   * The ~25 pages built on `useResourceDetail` hand the tab no error: it
   * asks the manifest read itself. Fails if a page that passes only a kind
   * and a name keeps the skeleton when that read fails, or never shows the
   * text once a second read answers.
   */
  it("asks the manifest read itself when the page gave it no error", async () => {
    manifest.read.mockRejectedValueOnce(new Error("forbidden"));
    manifest.read.mockResolvedValueOnce(APPLIABLE);
    renderWithProviders(
      <YamlTabContent
        yaml={undefined}
        resourceKind="Deployment"
        resourceName="legacy-billing"
        namespace="platform"
        onCopy={() => {}}
      />
    );

    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    expect(await screen.findByTestId("yaml-editor")).toHaveTextContent(
      "legacy-billing"
    );
  });
});
