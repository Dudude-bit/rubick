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
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computed(element);
    return new Proxy(style, {
      get: (target, key) => {
        if (key === "lineHeight") return "16px";
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
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

  /**
   * In WebKitGTK a clamp of one line still drew two when the sentence ended
   * in "Learn more", an inline-flex link, and Dana's rows dropped 15 px with
   * the description held. Fails if the hold is only the clamp and not the
   * height of the lines it keeps.
   */
  it("holds the height of the lines it keeps, not only a clamp", async () => {
    wraps = 1;
    const { held, go } = await render();
    wraps = 2;
    await go("/c/prod/pods?peek=pods%2Fns%2Fa-1");
    expect(held().style.height).toBe("16px");
  });

  /**
   * A page opened with its peek already open lays out beside it, and closing
   * the peek unwrapped the sentence and pulled every row up. Fails if the
   * page clips to a guess while the peek is open, or gives back the room of
   * the lines it had beside the peek once it closes.
   */
  it("keeps the room a page opened beside a peek had when the peek closes", async () => {
    wraps = 2;
    const rendered = await renderWithRouter(
      <p>
        <HeldLines>{SENTENCE}</HeldLines>
      </p>,
      { at: "/c/prod/pods?peek=pods%2Fns%2Fa-1" }
    );
    const held = () => screen.getByText(SENTENCE);
    expect(held().style.webkitLineClamp).toBe("");

    wraps = 1;
    await act(() =>
      rendered.router.navigate({ href: "/c/prod/pods" }).then(() => undefined)
    );
    expect(held().style.webkitLineClamp).toBe("2");
    expect(held().style.height).toBe("32px");
  });
});
