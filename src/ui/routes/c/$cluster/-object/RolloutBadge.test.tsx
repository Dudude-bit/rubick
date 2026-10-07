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
