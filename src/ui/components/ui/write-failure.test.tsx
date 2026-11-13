import { describe, expect, it } from "vite-plus/test";

import { renderWithProviders } from "@/test/render";
import { WriteFailure } from "./write-failure";

const failure = (code: string) => Object.assign(new Error("denied"), { code });

describe("a write's failure inside its dialog", () => {
  /**
   * Every read refusal is a lock and the write refusal was a circled x.
   * Fails if a refusal stops wearing the lock, or another failure borrows it.
   */
  it("wears the lock for a refusal and the cross for any other failure", async () => {
    const refused = await renderWithProviders(
      <WriteFailure error={failure("PERMISSION_DENIED")} />
    );
    expect(refused.container.querySelector(".lucide-lock")).not.toBeNull();
    expect(refused.container.querySelector(".lucide-circle-x")).toBeNull();
    refused.unmount();

    const other = await renderWithProviders(
      <WriteFailure error={failure("KUBE_API_ERROR")} />
    );
    expect(other.container.querySelector(".lucide-circle-x")).not.toBeNull();
    expect(other.container.querySelector(".lucide-lock")).toBeNull();
  });
});
