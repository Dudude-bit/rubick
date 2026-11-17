import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AuditPage, AuditSummary } from "@/generated/types";
import { renderWithRouter } from "@/test/render";

const power: { current: Record<string, unknown> } = {
  current: { state: "absent" },
};
const readAgain = vi.fn(() => Promise.resolve());

vi.mock("@/integrations", () => ({
  useCapabilityState: () => power.current,
}));
vi.mock("@/lib/commands", () => ({
  commands: { readAuditAgain: () => readAgain() },
}));

const { AuditSummaryBlock } = await import("./AuditSummary");

const summary = (over: Partial<AuditSummary> = {}): AuditSummary => ({
  findings: 0,
  severities: { high: 0, medium: 0, low: 0 },
  categories: { security: 0, reliability: 0, efficiency: 0, upgrade: 0 },
  rules: [],
  checked: [{ kind: "Deployment", objects: 12 }],
  notChecked: [],
  late: [],
  system: { namespaces: [], objects: 0, findings: 0 },
  reading: 0,
  unattributed: 0,
  enforced: [],
  enforcedUnread: null,
  upgrade: { read: "2026-11-14T10:00:00Z", server: "v1.31.4" },
  usage: null,
  ...over,
});

const page = (over: Partial<AuditSummary> = {}): AuditPage => ({
  revision: 1,
  summary: summary(over),
  rows: [],
  total: 0,
  next: null,
});

describe("Audit's summary of a scope", () => {
  /**
   * Nothing found among what was read is not nothing wrong. Fails if a
   * refused kind sits beside "nothing to report", which is a 403 dressed as
   * a clean cluster.
   */
  it("never says there is nothing to report beside a kind it could not read", () => {
    render(
      <AuditSummaryBlock
        page={page({
          notChecked: [
            {
              kind: "PodDisruptionBudget",
              namespace: "shop",
              why: { says: "refused", message: "forbidden" },
              rules: ["no-disruption-budget"],
            },
          ],
        })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.queryByText(/Nothing to report/)).toBeNull();
    expect(
      screen.getByText(/Nothing found in what could be read/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("PodDisruptionBudget in shop: refused: forbidden")
    ).toBeInTheDocument();
  });

  /** Fails if pods still being read count as checked and found clean. */
  it("says the namespaces' Pod Security labels were not read, with why", () => {
    render(
      <AuditSummaryBlock
        page={page({
          enforcedUnread: {
            says: "refused",
            message: "namespaces is forbidden",
          },
        })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.getByTestId("audit-enforced-unread")).toHaveTextContent(
      "Which namespaces enforce Pod Security was not read: refused: namespaces is forbidden"
    );
  });

  it("does not call a scope clean while pods are still being read", () => {
    render(
      <AuditSummaryBlock
        page={page({ reading: 3 })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.queryByText(/Nothing to report/)).toBeNull();
    expect(
      screen.getByText(/3 pods with no workload Audit reads/)
    ).toBeInTheDocument();
  });

  /** Where everything was read and nothing found, it says so and what it checked. */
  it("says there is nothing to report only where everything was read", () => {
    render(<AuditSummaryBlock page={page()} scope="shop" system={false} />);
    expect(screen.getByText(/Nothing to report in shop/)).toBeInTheDocument();
    expect(screen.getByText("Checked: Deployment 12")).toBeInTheDocument();
  });

  /**
   * Before the upgrade rules' first pass ends, the scope is not clean. Fails
   * if a scope read for everything but Helm releases and writers said there
   * was nothing to report.
   */
  it("does not call a scope clean while the upgrade rules are still reading", () => {
    render(
      <AuditSummaryBlock
        page={page({ upgrade: { read: null, server: "v1.31.4" } })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.queryByText(/Nothing to report/)).toBeNull();
    expect(screen.getByTestId("audit-upgrade-read")).toHaveTextContent(
      /still reading Helm releases/
    );
  });

  /** Once read, the line says against which Kubernetes, and Helm releases are counted in words. */
  it("says what the upgrade rules were read against", () => {
    render(
      <AuditSummaryBlock
        page={page({
          checked: [{ kind: "HelmRelease.helm.sh", objects: 3 }],
        })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.getByTestId("audit-upgrade-read")).toHaveTextContent(
      /against Kubernetes v1\.31\.4/
    );
    expect(screen.getByText("Checked: Helm releases 3")).toBeInTheDocument();
  });

  /**
   * Requests not weighed against use, whether for want of a Prometheus or
   * for an object the reading held no sample of, leave the scope not clean.
   * Fails if "nothing to report" stood beside either.
   */
  it("does not call a scope clean while requests were not weighed against use", () => {
    const { unmount } = render(
      <AuditSummaryBlock
        page={page({ usage: { says: "noSupplier" } })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.queryByText(/Nothing to report/)).toBeNull();
    expect(screen.getByTestId("audit-usage-read")).toHaveTextContent(
      /no Prometheus is connected/
    );
    unmount();
    render(
      <AuditSummaryBlock
        page={page({
          usage: { says: "read", window: "24h" },
          rules: [
            {
              rule: "requests-above-usage",
              objects: 0,
              unchecked: 2,
              system: 0,
            },
          ],
        })}
        scope="shop"
        system={false}
      />
    );
    expect(screen.queryByText(/Nothing to report/)).toBeNull();
    expect(screen.getByTestId("audit-usage-read")).toHaveTextContent(
      /weighed over the last 24 hours/
    );
  });

  /**
   * A Prometheus that did not answer its probe is asked again from the line
   * that says so, its own probe re-run, beside a link to its connection;
   * the API server's count, which Audit reads itself, is read again at
   * once. Fails if either line leaves the reader to find a Test button
   * somewhere else.
   */
  it("offers to ask again where Prometheus did not answer", async () => {
    const askAgain = vi.fn();
    power.current = {
      state: "unreachable",
      vendor: "Prometheus",
      endpoint: "http://localhost:9090",
      reason: "Connection refused",
      askAgain,
      asking: false,
      settings: {
        to: "/c/$cluster/integrations/$vendor",
        params: { cluster: "prod", vendor: "prometheus" },
      },
    };
    try {
      await renderWithRouter(
        <AuditSummaryBlock
          page={page({
            usage: { says: "failed", said: "Connection refused" },
            notChecked: [
              {
                kind: "apiserver_requested_deprecated_apis",
                namespace: null,
                why: { says: "failed", message: "Connection refused" },
                rules: ["deprecated-api-requested"],
              },
            ],
          })}
          scope="shop"
          system={false}
        />,
        { at: "/c/prod/audit", route: "/c/$cluster/audit" }
      );
      const user = userEvent.setup();
      await user.click(screen.getByTestId("ask-supplier-again"));
      expect(askAgain).toHaveBeenCalledOnce();
      await user.click(screen.getByTestId("audit-read-again"));
      expect(readAgain).toHaveBeenCalledOnce();
    } finally {
      power.current = { state: "absent" };
    }
  });

  /** A refusal across the whole cluster points at the namespace picker. */
  it("points at the namespace picker when a kind is refused across the cluster", () => {
    render(
      <AuditSummaryBlock
        page={page({
          notChecked: [
            {
              kind: "Deployment",
              namespace: null,
              why: { says: "refused", message: "forbidden" },
              rules: ["pss-privileged"],
            },
          ],
        })}
        scope="all namespaces"
        system={false}
      />
    );
    expect(
      screen.getByText(/Pick the namespaces you can read/)
    ).toBeInTheDocument();
  });
});
