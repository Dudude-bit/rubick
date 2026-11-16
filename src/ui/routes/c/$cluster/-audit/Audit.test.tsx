import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AuditPage, AuditQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const asked: AuditQuery[] = [];
const moreRules: AuditPage["rows"] = [];
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
          ...moreRules,
        ],
        total: 1 + moreRules.length,
        next: null,
      });
    },
  },
}));

const { Audit } = await import("./Audit");

beforeEach(() => {
  asked.length = 0;
  moreRules.length = 0;
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

  /**
   * A rule opened from a table of forty is drawn under the table, below the
   * fold: it is brought into view and takes the focus, by click and by
   * Enter alike. Fails if opening a rule changes nothing in sight, which
   * reads as a dead click.
   */
  it("brings an opened rule into view and gives it the focus", async () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      await renderWithRouter(<Audit />, {
        at: "/c/prod/audit",
        route: "/c/$cluster/audit",
      });
      const row = await screen.findByText("No PodDisruptionBudget");
      await userEvent.setup().click(row);
      const opened = screen.getByTestId("audit-opened-rule");
      await waitFor(() => expect(scrolled).toContain(opened));
      expect(document.activeElement).toBe(opened);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  /**
   * The table's footer counts rules in its own words, not the row label
   * glued to a count that already has its noun. Fails if it reads "1
   * object Findings".
   */
  /**
   * A rule that found nothing and only could not check is not a finding of
   * its severity. Fails if its row wears the rule's red High badge.
   */
  it("draws a rule that only could not check as not checked, with no severity", async () => {
    moreRules.push({
      row: "rule",
      rule: "autoscaler-target-missing",
      worst: null,
      objects: 0,
      unchecked: 1,
    });
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    const title = await screen.findByText("Autoscaler's target does not exist");
    const row = title.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByText("High")).toBeNull();
    expect(
      within(row as HTMLElement).getByLabelText("Not checked here")
    ).toBeInTheDocument();
  });

  it("counts the table's rows as rules", async () => {
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    expect(await screen.findByText("1 rule")).toBeInTheDocument();
  });

  /**
   * The opened rule is named once, in its heading, with the badge and the
   * category beside it. Fails if the title is printed twice.
   */
  it("names an opened rule once", async () => {
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    await userEvent
      .setup()
      .click(await screen.findByText("No PodDisruptionBudget"));
    const opened = screen.getByTestId("audit-opened-rule");
    await waitFor(() =>
      expect(within(opened).getByText("keeps 3 replicas")).toBeInTheDocument()
    );
    expect(within(opened).getAllByText("No PodDisruptionBudget")).toHaveLength(
      1
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
