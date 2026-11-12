import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const asked = vi.hoisted(() => ({
  order: [] as string[],
  forget: (): Promise<void> => Promise.resolve(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    forgetDiscovery: () => {
      asked.order.push("forget");
      return asked.forget();
    },
  },
}));

const { ReadAgain } = await import("./read-again");

beforeEach(() => {
  asked.order = [];
  asked.forget = () => Promise.resolve();
});

describe("asking a read again", () => {
  /** Fails if the retry reaches the backend while it still holds the miss that said a kind installed since is not served. */
  it("drops what discovery said before it asks", async () => {
    render(
      <ReadAgain error={null} onRetry={() => asked.order.push("retry")} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Try the read again" }));
    await waitFor(() => expect(asked.order).toEqual(["forget", "retry"]));
  });

  /** Fails if a forget the backend could not do swallows the read it was asked for. */
  it("asks even where discovery could not be dropped", async () => {
    asked.forget = () => Promise.reject(new Error("no cluster"));
    const retry = vi.fn();
    render(<ReadAgain error={null} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try the read again" }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  });
});
