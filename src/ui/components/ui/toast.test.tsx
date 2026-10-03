import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Toast, ToastDescription, ToastProvider, ToastViewport } from "./toast";

describe("ToastDescription", () => {
  /**
   * Descriptions are built as lines joined with "\n" — saved paths, several
   * answers at once. Without a white-space rule that keeps them, the lines ran
   * together and a path with a space in it could not be told from the next.
   */
  it("keeps the line breaks a description is written with", () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastDescription>{"/a/one.log\n/b/two.log"}</ToastDescription>
        </Toast>
        <ToastViewport />
      </ToastProvider>
    );
    const description = screen.getByText(/one\.log/);
    expect(description.className.split(/\s+/)).toContain("whitespace-pre-line");
  });
});
