import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PlacedSection } from "@/lib/report-parts";
import { useSurfaceVisible } from "@/lib/surface-visibility";

type Build = () => PlacedSection | PlacedSection[] | null;

interface Registry {
  offer: (id: string, read: () => Build) => () => void;
  collect: () => PlacedSection[];
}

const ScreenShare = createContext<Registry | null>(null);

/**
 * The screen's shareable parts, gathered from whatever draws them.
 *
 * A list, a finding list or a ladder registers what it has on screen; the
 * Share button reads them all at the moment it is pressed. So a page gets a
 * report of itself by drawing through the shared components, and nobody
 * keeps a second copy of what a screen shows.
 */
export function ScreenShareProvider({ children }: { children: ReactNode }) {
  const [builders] = useState(() => new Map<string, () => Build>());
  const registry = useMemo<Registry>(
    () => ({
      offer: (id, read) => {
        builders.set(id, read);
        return () => {
          if (builders.get(id) === read) builders.delete(id);
        };
      },
      collect: () =>
        [...builders.values()].flatMap((read) => {
          const built = read()();
          return built === null ? [] : Array.isArray(built) ? built : [built];
        }),
    }),
    [builders]
  );
  return createElement(ScreenShare.Provider, { value: registry }, children);
}

/**
 * Offers `build` to this screen's Share while the surface holding it is the
 * one on screen: a tab parked behind another is not what the reader sees.
 * A `null` id offers nothing, for a shared component used without a share.
 */
export function useShareSection(id: string | null, build: Build): void {
  const registry = useContext(ScreenShare);
  const visible = useSurfaceVisible();
  const latest = useRef(build);
  useEffect(() => {
    latest.current = build;
  });
  useEffect(() => {
    if (!registry || !visible || id === null) return;
    return registry.offer(id, () => latest.current);
  }, [registry, visible, id]);
}

export function useScreenSections(): (() => PlacedSection[]) | null {
  return useContext(ScreenShare)?.collect ?? null;
}
