import { useMemo } from "react";

import type { PathIdentity } from "@/generated/types";
import { usePrivacyStore } from "@/stores/privacyStore";

const CONTINUES = /^[\p{Alphabetic}\p{N}_.-]$/u;

const lastChar = (text: string) => [...text.slice(-2)].at(-1);

function replaceWhole(
  text: string,
  needle: string,
  by: string,
  starts: (before: string | undefined) => boolean
): string {
  if (!needle) return text;
  let out = "";
  let rest = text;
  for (let at = rest.indexOf(needle); at !== -1; at = rest.indexOf(needle)) {
    const before = lastChar(rest.slice(0, at)) ?? lastChar(out);
    const next = rest.codePointAt(at + needle.length);
    const ends =
      next === undefined || !CONTINUES.test(String.fromCodePoint(next));
    out += rest.slice(0, at) + (starts(before) && ends ? by : needle);
    rest = rest.slice(at + needle.length);
  }
  return out + rest;
}

/** `PathIdentity::hide` in redact.rs, held to it by path-redaction-conformance.json. */
export function hidePath(text: string, { roots, user }: PathIdentity): string {
  let out = text;
  for (const { root, standIn } of roots)
    out = replaceWhole(out, root, standIn, () => true);
  return user
    ? replaceWhole(
        out,
        user,
        "<user>",
        (before) => before === "/" || before === "\\"
      )
    : out;
}

const showing =
  (hide: boolean, identity: PathIdentity | null) => (text: string) =>
    hide && identity ? hidePath(text, identity) : text;

/** A text naming paths on this computer as a toast or a handler may say it. */
export const shownPath = (text: string): string => {
  const { hidePaths, identity } = usePrivacyStore.getState();
  return showing(hidePaths, identity)(text);
};

/** {@link shownPath} for a render, drawn again when the box is ticked. */
export function useShownPath(): (text: string) => string {
  const hide = usePrivacyStore((state) => state.hidePaths);
  const identity = usePrivacyStore((state) => state.identity);
  return useMemo(() => showing(hide, identity), [hide, identity]);
}
