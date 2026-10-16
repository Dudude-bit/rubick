import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useLocaleStore } from "@/stores/localeStore";
import type { RowCause } from "../../-components/row-cause";
import { JobStatusCell } from "./JobStatusCell";

const NONE: RowCause = { says: "read", shared: null };

afterEach(() => useLocaleStore.setState({ choice: "en" }));

describe("a Job's status in the list", () => {
  /**
   * The list read Failed in red as soon as one pod failed, while the
   * Overview, reading the controller's condition, called the same Job fine.
   */
  it("says a Job with failed pods and retries left is retrying, with how many failed", () => {
    render(
      <JobStatusCell
        job={{ status: "Retrying", failed: 2, failure: null, podsCause: NONE }}
      />
    );
    expect(screen.getByText("Retrying")).toHaveClass("text-warn");
    expect(screen.getByText("2 failed pods")).toHaveClass("text-warn");
  });

  /** Failed is the controller's word, and carries its reason. */
  it("names the reason the controller gave up beside Failed", () => {
    render(
      <JobStatusCell
        job={{
          status: "Failed",
          failed: 7,
          failure: { reason: "DeadlineExceeded", message: null },
          podsCause: NONE,
        }}
      />
    );
    expect(screen.getByText("Failed")).toHaveClass("text-err");
    expect(screen.getByText("DeadlineExceeded")).toBeInTheDocument();
  });

  /**
   * Lena read "Fai… BackoffLimitEx…", and later "Failed BackoffLimitEx… 2 of
   * 2 pods: report exited": the reason a reader matches against kubectl gave
   * way to the cause after it. Fails if the badge or the reason can shrink,
   * or a reason past the floor's 24 glyphs stops ending in an ellipsis.
   */
  it("keeps the badge and the controller's reason whole and lets the pods' cause give way", () => {
    render(
      <JobStatusCell
        job={{
          status: "Failed",
          failed: 7,
          failure: { reason: "BackoffLimitExceeded", message: null },
          podsCause: NONE,
        }}
      />
    );
    expect(screen.getByText("Failed").closest(".flex-none")).not.toBeNull();
    expect(screen.getByText("BackoffLimitExceeded")).toHaveClass(
      "flex-none",
      "max-w-[24ch]",
      "truncate"
    );
  });
});

describe("the cause a Job's pods share, in its row", () => {
  /**
   * The Jobs list said "Failed BackoffLimitExceeded" for a report whose
   * every run exited 2, and only the page said so. Fails if the row does
   * not tell its pods' cause after the controller's reason, or tells one
   * for a Job that completed.
   */
  it("tells it after the reason, and not once the Job is complete", () => {
    const podsCause: RowCause = {
      says: "read",
      shared: {
        pods: 2,
        of: 2,
        cause: {
          says: "exits",
          container: "report",
          restarts: 0,
          run: null,
          until: null,
        },
      },
    };
    const failure = { reason: "BackoffLimitExceeded", message: null };
    const { rerender } = render(
      <JobStatusCell
        job={{ status: "Failed", failed: 2, failure, podsCause }}
      />
    );
    const cause = screen.getByTestId("row-cause");
    expect(cause).toHaveTextContent(/^2 of 2 pods: report/);
    expect(cause).toHaveClass("min-w-0", "truncate");
    expect(
      screen.getByText("BackoffLimitExceeded").compareDocumentPosition(cause) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    rerender(
      <JobStatusCell
        job={{ status: "Complete", failed: 0, failure: null, podsCause }}
      />
    );
    expect(screen.queryByTestId("row-cause")).toBeNull();
  });

  /** Fails if a failed Job whose pods were refused reads like one with nothing to tell. */
  it("says its pods were not read where it failed", () => {
    render(
      <JobStatusCell
        job={{
          status: "Failed",
          failed: 1,
          failure: null,
          podsCause: { says: "unread" },
        }}
      />
    );
    expect(
      screen.getByText("pods not read, so why is not known")
    ).toBeInTheDocument();
  });
});

describe("a Job's status word in Russian", () => {
  /** "Suspended" is our reading of spec.suspend; fails if it stays English beside a Russian row. */
  it("words Suspended, which the app composes, and keeps its colour", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <JobStatusCell
        job={{ status: "Suspended", failed: 0, failure: null, podsCause: NONE }}
      />
    );
    expect(screen.getByText("Приостановлен")).toBeInTheDocument();
    expect(screen.queryByText("Suspended")).toBeNull();
  });

  /** "Failed" is a condition type the cluster wrote; fails if it is translated. */
  it("keeps Failed as the cluster wrote it", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <JobStatusCell
        job={{ status: "Failed", failed: 1, failure: null, podsCause: NONE }}
      />
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
