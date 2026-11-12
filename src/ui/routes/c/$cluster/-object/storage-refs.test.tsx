import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { ClaimRef, StorageClassRef } from "./storage-refs";

describe("a volume with no claim or no class", () => {
  /**
   * An unbound PersistentVolume's Claim cell was an escape written as JSX
   * text, which draws its own six characters, and a volume with no class
   * drew a bare dash. Fails if either says anything but the word for none,
   * or a claim's fallback words are lost.
   */
  it("says none in words, in the list, on the page and in the peek", () => {
    const { container, rerender } = render(<ClaimRef claim={null} />);
    expect(container).toHaveTextContent(/^none$/);
    rerender(<StorageClassRef name={null} />);
    expect(container).toHaveTextContent(/^none$/);
    rerender(<StorageClassRef name={null} fallback="cluster default" />);
    expect(screen.getByText("cluster default")).toBeInTheDocument();
  });
});
