import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useLocaleStore } from "@/stores/localeStore";
import { JobStatusCell } from "./JobStatusCell";

afterEach(() => useLocaleStore.setState({ choice: "en" }));

describe("a Job's status in the list", () => {
  /**
   * The list read Failed in red as soon as one pod failed, while the
   * Overview, reading the controller's condition, called the same Job fine.
   */
  it("says a Job with failed pods and retries left is retrying, with how many failed", () => {
    render(
      <JobStatusCell job={{ status: "Retrying", failed: 2, failure: null }} />
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
        }}
      />
    );
    expect(screen.getByText("Failed")).toHaveClass("text-err");
    expect(screen.getByText("DeadlineExceeded")).toBeInTheDocument();
  });
});

describe("a Job's status word in Russian", () => {
  /** "Suspended" is our reading of spec.suspend; fails if it stays English beside a Russian row. */
  it("words Suspended, which the app composes, and keeps its colour", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <JobStatusCell job={{ status: "Suspended", failed: 0, failure: null }} />
    );
    expect(screen.getByText("Приостановлен")).toBeInTheDocument();
    expect(screen.queryByText("Suspended")).toBeNull();
  });

  /** "Failed" is a condition type the cluster wrote; fails if it is translated. */
  it("keeps Failed as the cluster wrote it", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <JobStatusCell job={{ status: "Failed", failed: 1, failure: null }} />
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
