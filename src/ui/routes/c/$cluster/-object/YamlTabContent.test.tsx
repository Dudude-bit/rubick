import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { WITHHELD_MARKER } from "@/lib/withheld";
import { renderWithProviders } from "@/test/render";
import { YamlTabContent } from "./YamlTabContent";

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
});
