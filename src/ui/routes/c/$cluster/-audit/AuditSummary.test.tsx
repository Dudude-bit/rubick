import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import type { AuditPage, AuditSummary } from "@/generated/types";
import { AuditSummaryBlock } from "./AuditSummary";

const summary = (over: Partial<AuditSummary> = {}): AuditSummary => ({
  findings: 0,
  severities: { high: 0, medium: 0, low: 0 },
  categories: { security: 0, reliability: 0, efficiency: 0 },
  rules: [],
  checked: [{ kind: "Deployment", objects: 12 }],
  notChecked: [],
  late: [],
  system: { namespaces: [], objects: 0, findings: 0 },
  reading: 0,
  unattributed: 0,
  enforced: [],
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
