import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useLinkGesture } from "@/hooks/useLinkGesture";
import { useObjectMenuStore } from "@/stores/objectMenuStore";

interface RouteLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "onClick" | "onAuxClick"
> {
  to: string;
  children: ReactNode;
  /**
   * The object's name for the right-click menu, where it is not the words
   * on screen: a CRD row is labelled with its kind and called
   * `applications.argoproj.io`. Left out, the label is the name.
   */
  menuName?: string;
}

/**
 * A link to somewhere the router serves that is not a resource reference:
 * a Helm release, a CRD, a custom resource instance. `ResourceRef` covers
 * every kind the registry can name and offers a peek; these destinations
 * have neither, so a plain click goes there. The modified gestures are the
 * same ones, from the same place.
 */
export function RouteLink({ to, children, menuName, ...rest }: RouteLinkProps) {
  const navigate = useNavigate();
  const gesture = useLinkGesture();

  const handle = (event: MouseEvent<HTMLAnchorElement>) =>
    gesture(event, to, () => navigate(to));

  // The same menu `ObjectLink` opens. Without it the webview's own appears,
  // whose "Copy link address" copies `http://tauri.localhost/...` — the
  // complaint in #178 item 1, and these are the rows it was still true of:
  // every custom resource, every Helm release, every CRD.
  const menu = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    useObjectMenuStore.getState().open({
      name: menuName ?? event.currentTarget.textContent?.trim() ?? to,
      to,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <Link
      to={to}
      onClick={handle}
      onAuxClick={handle}
      onContextMenu={menu}
      {...rest}
    >
      {children}
    </Link>
  );
}
