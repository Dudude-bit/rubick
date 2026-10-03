import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parts } from "./parts";

describe("a sentence with an element inside it", () => {
  it("puts the node where the placeholder is", () => {
    render(
      <p>{parts("stopped on {name}, and waiting", { name: <b>init</b> })}</p>
    );
    expect(screen.getByText("init").tagName).toBe("B");
    expect(document.body.textContent).toBe("stopped on init, and waiting");
  });

  /**
   * The whole point. English puts the container first, and a translation is
   * free to put it last; the element travels with the placeholder.
   */
  it("follows the translation's word order, not the English one", () => {
    render(<p>{parts("и на {name} всё встало", { name: <b>init</b> })}</p>);
    expect(document.body.textContent).toBe("и на init всё встало");
  });

  it("leaves a placeholder with no node alone", () => {
    render(<p>{parts("{a} and {b}", { a: <b>one</b> })}</p>);
    expect(document.body.textContent).toBe("one and {b}");
  });
});
