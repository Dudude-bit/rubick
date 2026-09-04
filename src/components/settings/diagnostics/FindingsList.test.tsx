import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Finding } from "@/generated/types";
import { FindingsList } from "./FindingsList";

const blocking: Finding = {
  severity: "blocking",
  title: "kubectl-oidc_login is not installed",
  detail: "The context context-1 authenticates with `kubectl oidc-login`.",
  subject: "context-1",
  aboutShell: false,
};

const optional: Finding = {
  severity: "optional",
  title: "helm was not found",
  detail: "Chart browsing is unavailable until it is installed.",
  subject: null,
  aboutShell: false,
};

describe("FindingsList", () => {
  it("puts what breaks a connection above what merely limits a feature", () => {
    render(<FindingsList findings={[optional, blocking]} />);

    const titles = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(titles).toEqual([blocking.title, optional.title]);
  });

  it("keeps the same order for two findings of one severity", () => {
    // Two reads of an unchanged machine that swap rows look like something
    // changed. The subject is the tiebreak.
    const b: Finding = { ...blocking, title: "b is missing", subject: "beta" };
    const a: Finding = { ...blocking, title: "a is missing", subject: "alpha" };

    render(<FindingsList findings={[b, a]} />);
    const titles = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(titles).toEqual(["a is missing", "b is missing"]);
  });

  it("says nothing needs attention rather than rendering blank", () => {
    render(<FindingsList findings={[]} />);
    expect(
      screen.getByText(/nothing here needs attention/i)
    ).toBeInTheDocument();
  });
});
