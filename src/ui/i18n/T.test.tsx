import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLocaleStore } from "@/stores/localeStore";
import { T } from "./T";

describe("a translated string as an element", () => {
  beforeEach(() => {
    useLocaleStore.setState({ choice: "en" });
  });

  it("renders the English", () => {
    render(<T section="action" k="cancel" />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("follows the reader's choice", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(<T section="action" k="cancel" />);
    expect(screen.getByText("Отмена")).toBeInTheDocument();
  });

  it("counts, with the forms the language uses", () => {
    useLocaleStore.setState({ choice: "ru" });
    render(<T section="cluster" k="podCount" values={{ n: 5 }} />);
    expect(screen.getByText("5 подов")).toBeInTheDocument();
  });

  /**
   * The whole reason this component exists: a column header is defined in a
   * module-level array that cannot call a hook, and is rendered through
   * `flexRender` inside the tree, where one can.
   */
  it("works from a column definition, which is where hooks cannot go", () => {
    const column = {
      id: "name",
      header: () => <T section="columns" k="name" />,
    };
    const Header = column.header;
    render(<Header />);
    expect(screen.getByText("Name")).toBeInTheDocument();
  });
});
