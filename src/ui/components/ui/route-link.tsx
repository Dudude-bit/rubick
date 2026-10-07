import type { MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { useLinkGesture } from "@/hooks/useLinkGesture";
import { hrefOf, type AppLink } from "@/lib/links";
import { useObjectMenuStore } from "@/stores/objectMenuStore";

type RouteLinkProps = AppLink & {
  children: ReactNode;
  className?: string;
  /**
   * The object's name for the right-click menu, where it is not the words
   * on screen: a CRD row is labelled with its kind and called
   * `applications.argoproj.io`. Left out, the label is the name.
   */
  menuName?: string;
};

/**
 * A link to somewhere the router serves that is not a resource reference:
 * a Helm release, a CRD. `ResourceRef` covers
 * every kind the registry can name and offers a peek; these destinations
 * have neither, so a plain click goes there. The modified gestures are the
 * same ones, from the same place.
 */
export function RouteLink({
  children,
  className,
  menuName,
  ...rest
}: RouteLinkProps) {
  const navigate = useNavigate();
  const gesture = useLinkGesture();
  const link = rest as AppLink;

  const handle = (event: MouseEvent<HTMLAnchorElement>) =>
    gesture(event, hrefOf(link), () => navigate(link));

  // The same menu `ObjectLink` opens. Without it the webview's own appears,
  // whose "Copy link address" copies `http://tauri.localhost/...` — the
  // complaint in #178 item 1, and these are the rows it was still true of:
  // every custom resource, every Helm release, every CRD.
  const menu = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const to = hrefOf(link);
    useObjectMenuStore.getState().open({
      name: menuName ?? event.currentTarget.textContent?.trim() ?? to,
      to,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <Link
      {...link}
      onClick={handle}
      onAuxClick={handle}
      onContextMenu={menu}
      className={className}
    >
      {children}
    </Link>
  );
}
