import { afterEach, describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import type { Rollout } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { ROLE_TEXT, statusRole } from "@/lib/status-role";
import { RolloutBadge } from "./RolloutSummary";

afterEach(() => useLocaleStore.setState({ choice: "en" }));

describe("a rollout's badge in Russian", () => {
  /** "Waiting" is the app's word for a generation the controller has not read; fails if it stays English. */
  it("words Waiting, which the app composes", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(<RolloutBadge rollout={{ state: "unobserved" } as Rollout} />);
    expect(screen.getByText("Ожидает")).toBeInTheDocument();
  });

  /** The colour still comes from the code, not from the words: a translated label must not turn the badge grey. */
  it("keeps the code's colour when the label is translated", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(<RolloutBadge rollout={{ state: "unobserved" } as Rollout} />);
    const colour = ROLE_TEXT[statusRole("Waiting")];
    expect(screen.getByText("Ожидает")).toHaveClass(colour);
  });
});

describe("a rollout's badge whose pods were not read", () => {
  /**
   * The list drew the controller's Unavailable red with no pods read to say
   * whether they were still starting. Fails if the badge takes the fault's
   * colour or loses the word the controller said.
   */
  it("keeps the controller's word in a neutral colour", () => {
    render(
      <RolloutBadge
        rollout={{
          state: "podsUnread",
          controller: {
            state: "unavailable",
            reason: null,
            message: null,
            available: 0,
            desired: 1,
          },
        }}
      />
    );
    const badge = screen.getByText("Unavailable");
    expect(badge).toHaveClass(ROLE_TEXT.neutral);
    expect(badge).not.toHaveClass(ROLE_TEXT.err);
  });
});
