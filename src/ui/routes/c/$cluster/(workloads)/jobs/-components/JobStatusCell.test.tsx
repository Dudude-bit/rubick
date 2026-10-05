import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { JobStatusCell } from "./JobStatusCell";

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
