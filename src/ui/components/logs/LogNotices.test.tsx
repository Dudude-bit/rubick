import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { useLocaleStore } from "@/stores/localeStore";
import { IntakeQuietNotice } from "./LogNotices";
import { parseQueryTerm, termLabel, type QueryTerm } from "./types";

describe("the notice that nothing has matched yet", () => {
  /**
   * The terms were joined with an English "and" inside the sentence, and the
   * sentence itself was two catalogue strings around them — so Russian read
   * "Ничего не совпало с level>=warn and pod=web уже 20 с".
   */
  it("lists the terms in the reader's language, inside one sentence", () => {
    useLocaleStore.setState({ choice: "ru" });
    const terms = [
      parseQueryTerm("level>=warn"),
      parseQueryTerm("pod=web"),
    ].filter((term): term is QueryTerm => term !== null);
    render(<IntakeQuietNotice since={Date.now() - 20_000} terms={terms} />);

    const notice = screen.getByTestId("log-intake-quiet");
    expect(notice).toHaveTextContent(
      `${termLabel(terms[0])} и ${termLabel(terms[1])}`
    );
    expect(notice).not.toHaveTextContent(" and ");
    useLocaleStore.setState({ choice: null });
  });
});
