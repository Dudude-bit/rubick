/**
 * The two halves that are each silent without the other.
 *
 * Entra Workload ID has no CRDs: an annotation on a ServiceAccount and a
 * label on a pod. Neither object mentions the other, so nothing in the app
 * could say which pods could become which identity — and the combination
 * that fails produces a 401 from Azure with no Kubernetes symptom at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { getManifest: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { workloadIdentity } from "./workload-identity";

const pod = (name: string, account: string | null, use = true) =>
  ({
    name,
    namespace: "web",
    labels: use ? { "azure.workload.identity/use": "true" } : {},
    serviceAccountName: account,
  }) as never;

const federated = (clientId: string) =>
  `metadata:\n  annotations:\n    azure.workload.identity/client-id: ${clientId}\n`;

describe("which pods can become which identity", () => {
  beforeEach(() => {
    vi.mocked(commands.getManifest).mockReset();
  });

  it("joins the labelled pod to its ServiceAccount's client id", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue(federated("abcd-1234"));

    const found = await workloadIdentity([pod("api-1", "api")]);

    expect(found.accounts).toHaveLength(1);
    expect(found.accounts[0]).toMatchObject({
      name: "api",
      namespace: "web",
      clientId: "abcd-1234",
    });
    expect(found.accounts[0].pods.map((entry) => entry.name)).toEqual([
      "api-1",
    ]);
    expect(found.findings).toEqual([]);
  });

  /**
   * The dangerous half. The webhook projects a token because the label is
   * there; the token is for no identity because the annotation is not.
   */
  it("names a labelled pod whose ServiceAccount grants nothing", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue("metadata: {}\n");

    const found = await workloadIdentity([pod("api-1", "api")]);

    expect(found.accounts).toEqual([]);
    expect(found.findings).toContainEqual(
      expect.objectContaining({ kind: "no-identity", account: "api" })
    );
  });

  /** A pod naming no ServiceAccount runs as `default`, and so does the check. */
  it("reads the default ServiceAccount for a pod that names none", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue(federated("x"));
    await workloadIdentity([pod("api-1", null)]);
    expect(vi.mocked(commands.getManifest).mock.calls[0][2]).toBe("default");
  });

  /** Without the label the webhook does nothing, so neither does this. */
  it("ignores a pod that did not opt in", async () => {
    const found = await workloadIdentity([pod("api-1", "api", false)]);
    expect(found.accounts).toEqual([]);
    expect(found.findings).toEqual([]);
    expect(commands.getManifest).not.toHaveBeenCalled();
  });

  /** One `get` per distinct ServiceAccount, not one per pod. */
  it("reads each ServiceAccount once for a whole Deployment", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue(federated("abcd"));

    const found = await workloadIdentity([
      pod("api-1", "api"),
      pod("api-2", "api"),
      pod("api-3", "api"),
    ]);

    expect(commands.getManifest).toHaveBeenCalledTimes(1);
    expect(found.accounts[0].pods).toHaveLength(3);
  });
});
