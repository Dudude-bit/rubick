import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { WITHHELD_MARKER } from "@/lib/withheld";
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

  /**
   * The Metadata tab and the peek draw the record kubectl keeps with its
   * private key blanked by the backend. Fails if the row stops saying the
   * placeholder inside is the app's, or says so of a record with none.
   */
  it("says the app withheld a key inside the record, and which", () => {
    const record = JSON.stringify({
      kind: "ConfigMap",
      data: {
        "nginx.conf": "worker_processes 2;",
        "server.key": WITHHELD_MARKER,
      },
    });
    const { unmount } = render(
      <KeyValueList
        items={[{ label: "last-applied", value: record, document: record }]}
      />
    );
    expect(
      screen.getByText(/^JSON · \d+ chars · withheld by the app: server\.key$/)
    ).toBeInTheDocument();
    unmount();

    render(
      <KeyValueList
        items={[{ label: "last-applied", value: manifest, document: manifest }]}
      />
    );
    expect(screen.getByText(/^JSON · [\d,\s]+ chars$/)).toBeInTheDocument();
  });
});
