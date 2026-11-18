import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AuditPage, AuditQuery } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const asked: AuditQuery[] = [];
const moreRules: AuditPage["rows"] = [];
let failing = false;
let paged: { total: number; next: number } | null = null;
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
  enforcedUnread: null,
  upgrade: { read: "2026-11-14T10:00:00Z", server: "v1.31.4" },
  usage: null,
};

vi.mock("@/lib/commands", () => ({
  commands: {
    forgetDiscovery: () => Promise.resolve(),
    getAudit: (
      _scope: string[] | null,
      query: AuditQuery
    ): Promise<AuditPage> => {
      asked.push(query);
      if (failing && query.rule === undefined)
        return Promise.reject(new Error("the API server did not answer"));
      if (query.by === "object")
        return Promise.resolve({
          revision: 1,
          summary,
          rows: [
            {
              row: "object",
              subject: {
                kind: "Deployment",
                namespace: "billing",
                name: "api",
              },
              worst: null,
              severities: { high: 0, medium: 0, low: 0 },
              rules: [],
              unchecked: 2,
            },
          ],
          total: 1,
          next: null,
        });
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
                what: [
                  {
                    says: "replicas",
                    replicas: 3,
                    autoscaler: null,
                    ceiling: null,
                  },
                ],
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
        total: paged?.total ?? 1 + moreRules.length,
        next: paged && query.offset === 0 ? paged.next : null,
      });
    },
  },
}));

const { Audit } = await import("./Audit");

beforeEach(() => {
  asked.length = 0;
  moreRules.length = 0;
  failing = false;
  paged = null;
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

  /**
   * A page forward is a page of one question. Fails if picking other
   * namespaces keeps asking from row 101 of an answer that now has 12, which
   * reads as no findings under a header that counts them.
   */
  it("goes back to the first page when the namespaces change", async () => {
    paged = { total: 150, next: 100 };
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit",
      route: "/c/$cluster/audit",
    });
    const range = await screen.findByText("1-1 / 150");
    const [, forward] = within(range.parentElement as HTMLElement).getAllByRole(
      "button"
    );
    await userEvent.setup().click(forward);
    await waitFor(() => expect(asked.at(-1)?.offset).toBe(100));
    act(() => useClusterStore.setState({ namespaceScope: ["shop"] }));
    await waitFor(() => expect(asked.at(-1)?.offset).toBe(0));
  });

  /**
   * An object no rule could answer for wears an eye, not a badge. Fails if
   * the eye says nothing to a screen reader, which hears an empty cell where
   * a sighted reader sees "not checked".
   */
  it("names the not-checked mark of an object to a screen reader", async () => {
    await renderWithRouter(<Audit />, {
      at: "/c/prod/audit?view=object",
      route: "/c/$cluster/audit",
    });
    const name = await screen.findByText("api");
    const row = name.closest("tr") as HTMLElement;
    expect(within(row).getByLabelText("Not checked here")).toBeInTheDocument();
  });

  /**
   * Opened from a link whose first read failed, the rule's panel mounts only
   * once the read asked again answers. Fails if it then stays out of view
   * and without the focus, as nothing in the opened row changed.
   */
  it("brings an opened rule into view when its panel mounts after a failed read", async () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    failing = true;
    try {
      await renderWithRouter(<Audit />, {
        at: "/c/prod/audit?rule=no-disruption-budget",
        route: "/c/$cluster/audit",
      });
      const again = await screen.findByRole("button", {
        name: /try the read again/i,
      });
      expect(screen.queryByTestId("audit-opened-rule")).toBeNull();
      failing = false;
      await userEvent.setup().click(again);
      const opened = await screen.findByTestId("audit-opened-rule");
      await waitFor(() => expect(scrolled).toContain(opened));
      expect(document.activeElement).toBe(opened);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
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
