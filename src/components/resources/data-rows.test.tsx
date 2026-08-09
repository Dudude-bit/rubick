import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataSection } from "./data-rows";

describe("DataSection", () => {
  it("shows a ConfigMap's values straight away", () => {
    render(<DataSection data={{ "log.level": "debug" }} />);
    expect(screen.getByText("log.level")).toBeInTheDocument();
    expect(screen.getByText("debug")).toBeInTheDocument();
  });

  it("hides a Secret's value behind a reveal that says so", async () => {
    render(<DataSection data={{ password: "hunter2" }} sensitive />);

    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
    // The affordance carries a word, not just an eye glyph: a masked value
    // and an empty one must not look the same.
    const reveal = screen.getByRole("button", { name: "Reveal" });

    await userEvent.click(reveal);
    expect(screen.getByText("hunter2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
  });

  it("reveals and re-hides every value at once", async () => {
    render(<DataSection data={{ a: "one", b: "two" }} sensitive />);

    await userEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect(screen.queryByText("one")).not.toBeInTheDocument();
  });

  it("lists keys it cannot read rather than claiming there is no data", () => {
    render(<DataSection data={{}} keys={["tls.crt"]} sensitive />);
    expect(screen.getByText("tls.crt")).toBeInTheDocument();
    expect(
      screen.getByText("not readable with this access")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
  });

  it("sorts keys so the block does not reorder between polls", () => {
    render(<DataSection data={{ zulu: "1", alpha: "2", mike: "3" }} />);
    const keys = screen
      .getAllByText(/^(zulu|alpha|mike)$/)
      .map((node) => node.textContent);
    expect(keys).toEqual(["alpha", "mike", "zulu"]);
  });

  it("says the object is empty when it holds nothing", () => {
    render(
      <DataSection data={{}} emptyMessage="This ConfigMap holds no keys" />
    );
    expect(
      screen.getByText("This ConfigMap holds no keys")
    ).toBeInTheDocument();
  });

  /**
   * Would break if a private key became renderable or copyable. The backend
   * withholds it, and the row that stands in for it must not offer either
   * control — a Reveal on a value the app does not hold is a button that
   * either lies or, worse, one day starts working.
   */
  it("offers neither reveal nor copy for a withheld value", () => {
    render(
      <DataSection
        data={{ "tls.crt": "-----BEGIN CERTIFICATE-----" }}
        withheld={{ "tls.key": "a private key — the app never shows one" }}
        keys={["tls.crt", "tls.key"]}
        sensitive
      />
    );

    expect(screen.getByText("tls.key")).toBeInTheDocument();
    expect(
      screen.getByText("a private key — the app never shows one")
    ).toBeInTheDocument();

    // One Reveal and one Copy, both belonging to tls.crt.
    expect(screen.getAllByRole("button", { name: "Reveal" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });

  /**
   * Would break if a withheld key were drawn as one the reader simply
   * cannot see — a different and untrue claim, and one that sends them to
   * ask for permissions they already have.
   */
  it("does not blame the reader's access for a withheld value", () => {
    render(
      <DataSection
        data={{}}
        withheld={{ "tls.key": "a private key — the app never shows one" }}
        keys={["tls.key"]}
        sensitive
      />
    );

    expect(
      screen.queryByText("not readable with this access")
    ).not.toBeInTheDocument();
  });
});
