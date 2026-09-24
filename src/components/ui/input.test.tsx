import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

describe("Input", () => {
  /** A caller passing `autoCorrect="on"` used to win over the default and
   *  hand the field back to macOS correction. */
  it("keeps correction off whatever the caller passes", () => {
    render(
      <Input
        aria-label="name"
        autoCorrect="on"
        autoCapitalize="on"
        spellCheck
      />
    );
    const field = screen.getByLabelText("name");

    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("autocapitalize", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
  });
});
