import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useLocaleStore } from "@/stores/localeStore";
import { KeyValueList } from "./detail-kv";

const manifest = JSON.stringify({ data: "x".repeat(31439) });

describe("a folded document", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * "JSON · 31450 chars" was English on every screen and the one count in
   * the app that skipped the translator, so a Russian reader got no group
   * space. Fails if the size line stops going through the catalogue.
   */
  it("says its size in the reader's language, grouped", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(
      <KeyValueList
        items={[{ label: "last-applied", value: manifest, document: manifest }]}
      />
    );
    expect(screen.getByText(/^JSON · 31\s450 символов$/)).toBeInTheDocument();
  });

  /** Fails if a document that is not JSON stops being named in the reader's language. */
  it("names plain text in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    const text = "line\n".repeat(30);
    render(
      <KeyValueList items={[{ label: "note", value: text, document: text }]} />
    );
    expect(screen.getByText(/^текст · 150 символов$/)).toBeInTheDocument();
  });
});
