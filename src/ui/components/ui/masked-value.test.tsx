import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useLocaleStore } from "@/stores/localeStore";
import { MaskedValue } from "./masked-value";

describe("the controls beside a masked value", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * The eye and copy buttons were glyphs with no name at all, so a screen
   * reader said "button" and nothing told the two apart.
   */
  it("names reveal and copy in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <MaskedValue
        value="hunter2"
        isRevealed={false}
        onToggleReveal={() => {}}
      />
    );
    expect(
      screen.getByRole("button", { name: "Показать" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Копировать" })
    ).toBeInTheDocument();
  });

  /** Would break if the compact form in the env table lost its names. */
  it("names hide in the compact form once the value is shown", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <MaskedValue
        value="hunter2"
        isRevealed
        onToggleReveal={() => {}}
        compact
      />
    );
    expect(screen.getByRole("button", { name: "Скрыть" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Копировать" })
    ).toBeInTheDocument();
  });
});
