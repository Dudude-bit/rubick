import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

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

describe("the YAML tab", () => {
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
});
