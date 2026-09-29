import type { LucideIcon } from "lucide-react";

type IconNode = Array<[string, Record<string, string | number>]>;

const markup = new Map<LucideIcon, string>();

/**
 * The drawing a lucide component carries, read from the element its outer
 * wrapper returns: that wrapper calls no hook, unlike the inner `Icon`, and
 * reading it keeps `react-dom/server` out of the bundle `@/integrations` is in.
 */
function nodeOf(icon: LucideIcon): IconNode {
  const wrapper = icon as unknown as {
    render?: (
      props: object,
      ref: null
    ) => {
      props?: { icon?: { node?: IconNode } };
    };
  };
  return wrapper.render?.({}, null)?.props?.icon?.node ?? [];
}

function attributes(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .filter(([name]) => name !== "key")
    .map(
      ([name, value]) =>
        `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${String(value).replace(/"/g, "&quot;")}"`
    )
    .join(" ");
}

/** An icon as inline SVG, for a file that must draw it without React or a request. */
export function iconSvg(icon: LucideIcon): string {
  let svg = markup.get(icon);
  if (svg === undefined) {
    const children = nodeOf(icon)
      .map(([tag, attrs]) => `<${tag} ${attributes(attrs)}/>`)
      .join("");
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
    markup.set(icon, svg);
  }
  return svg;
}
