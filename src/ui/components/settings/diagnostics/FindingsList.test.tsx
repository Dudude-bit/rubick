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

  /**
   * Would break if the shell finding went back to carrying its own words.
   *
   * The finding says it is *about* the shell and nothing more: the report
   * lives once, on `Diagnostics`, which is also the one the redactor scrubs.
   * So `title` and `detail` are empty on it, and a renderer that printed them
   * would draw a blank heading over a blank paragraph — which is what the
   * backend sends and what nothing here noticed.
   */
  it("words a shell finding from the catalogue, not from the finding", () => {
    render(
      <FindingsList
        findings={[
          {
            severity: "unverified",
            title: "",
            detail: "",
            subject: "/bin/zsh",
            aboutShell: true,
          },
        ]}
        shell={{ outcome: "timedOut", shell: "/bin/zsh", seconds: 30 }}
      />
    );

    const heading = screen.getByRole("heading", { level: 4 });
    expect(heading.textContent).not.toBe("");
    expect(heading).toHaveTextContent(/search path is a guess/i);
    // And the sentence under it names the shell and the deadline, which only
    // the report can supply.
    expect(screen.getByText(/\/bin\/zsh/)).toBeInTheDocument();
    expect(screen.getByText(/30/)).toBeInTheDocument();
  });
});
