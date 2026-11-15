import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AuditPage, AuditQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const asked: AuditQuery[] = [];
const summary: AuditPage["summary"] = {
  findings: 1,
  severities: { high: 1, medium: 0, low: 0 },
  categories: { security: 1, reliability: 0, efficiency: 0, upgrade: 0 },
  rules: [],
  checked: [{ kind: "Deployment", objects: 2 }],
  notChecked: [],
  late: [],
  system: { namespaces: ["kube-system"], objects: 1, findings: 4 },
  reading: 0,
  unattributed: 0,
  enforced: [],
  upgrade: { read: "2026-11-14T10:00:00Z", server: "v1.31.4" },
  usage: null,
};

vi.mock("@/lib/commands", () => ({
  commands: {
    getAudit: (
      _scope: string[] | null,
      query: AuditQuery
    ): Promise<AuditPage> => {
      asked.push(query);
      if (query.rule === "no-disruption-budget")
        return Promise.resolve({
          revision: 1,
          summary,
          rows: [
            {
              row: "found",
              subject: { kind: "Deployment", namespace: "shop", name: "web" },
              finding: {
                rule: "no-disruption-budget",
                severity: "low",
                what: [{ says: "replicas", replicas: 3, autoscaler: null }],
              },
            },
            {
              row: "blind",
              subject: {
                kind: "Deployment",
                namespace: "billing",
                name: "api",
              },
              unchecked: {
                rule: "no-disruption-budget",
                kind: "PodDisruptionBudget",
                namespace: "billing",
                why: { says: "refused", message: "forbidden" },
              },
            },
          ],
          total: 2,
          next: null,
        });
      return Promise.resolve({
        revision: 1,
        summary,
        rows: [
          {
            row: "rule",
            rule: "no-disruption-budget",
            worst: "low",
            objects: 1,
            unchecked: 1,
          },
        ],
        total: 1,
        next: null,
      });
    },
  },
}));

const { Audit } = await import("./Audit");

beforeEach(() => {
  asked.length = 0;
  useClusterStore.setState({
    currentContext: "prod",
    isConnected: true,
    namespaceScope: [],
  });
});

describe("the Audit page", () => {
  /**
   * An object a rule could not answer for is listed under the rule as not
   * checked, with the refusal. Fails if it is dropped from the rule's
   * objects, which reads as having passed.
   */
  it("lists under an opened rule the objects it could not check, with why", async () => {
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    const row = await screen.findByText("No PodDisruptionBudget");
    await userEvent.setup().click(row);
    await waitFor(() =>
      expect(
        screen.getByText("PodDisruptionBudget in billing: refused: forbidden")
      ).toBeInTheDocument()
    );
    expect(screen.getByText("keeps 3 replicas")).toBeInTheDocument();
    expect(asked.some((query) => query.rule === "no-disruption-budget")).toBe(
      true
    );
  });

  /** The system's own findings are folded under one line with their count, never hidden. */
  it("folds the system's findings under one line that opens them", async () => {
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    const fold = await screen.findByTestId("audit-system-fold");
    expect(fold).toHaveTextContent(
      "System namespaces and roles: 4 findings (kube-system)"
    );
    await userEvent.setup().click(fold);
    await waitFor(() => expect(asked.some((query) => query.system)).toBe(true));
  });
});
