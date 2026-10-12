import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { HeldLines } from "./HeldLines";

const SENTENCE = "A Pod is one running copy of an app.";

/** Lines the sentence wraps onto at the width it is drawn at now. */
let wraps = 1;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () =>
      Array.from(
        { length: wraps },
        () => new DOMRect()
      ) as unknown as DOMRectList
  );
});
afterEach(() => vi.restoreAllMocks());

const render = async () => {
  const rendered = await renderWithRouter(
    <p>
      <HeldLines>{SENTENCE}</HeldLines>
    </p>,
    { at: "/c/prod/pods" }
  );
  const held = () => screen.getByText(SENTENCE);
  const go = (href: string) =>
    act(() => rendered.router.navigate({ href }).then(() => undefined));
  return { held, go };
};

describe("a list's description beside a peek", () => {
  /**
   * Dana double clicked unready-demo and topology-demo opened: the peek the
   * first click opened made the description wrap onto a second line, and
   * every row moved 15 px down under the pointer. Fails if the description
   * takes more lines with a peek open than it had without one, or loses the
   * words it cut.
   */
  it("keeps the lines it had before the peek opened, and the rest on hover", async () => {
    wraps = 1;
    const { held, go } = await render();
    expect(held().style.webkitLineClamp).toBe("");

    wraps = 2;
    await go("/c/prod/pods?peek=pods%2Fns%2Fa-1");
    expect(held().style.webkitLineClamp).toBe("1");
    expect(held()).toHaveAttribute("title", SENTENCE);

    await go("/c/prod/pods");
    expect(held().style.webkitLineClamp).toBe("");
    expect(held()).not.toHaveAttribute("title");
  });

  /** A page opened with its peek already open has no resting width to keep; fails if it clips the sentence to a guess. */
  it("leaves a page opened with its peek already open as it lays out", async () => {
    wraps = 1;
    await renderWithRouter(
      <p>
        <HeldLines>{SENTENCE}</HeldLines>
      </p>,
      { at: "/c/prod/pods?peek=pods%2Fns%2Fa-1" }
    );
    expect(screen.getByText(SENTENCE).style.webkitLineClamp).toBe("");
  });
});
