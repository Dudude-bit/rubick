import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useLinkGesture } from "@/hooks/useLinkGesture";

interface RouteLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "onClick" | "onAuxClick"
> {
  to: string;
  children: ReactNode;
}

/**
 * A link to somewhere the router serves that is not a resource reference:
 * a Helm release, a CRD, a custom resource instance. `ResourceRef` covers
 * every kind the registry can name and offers a peek; these destinations
 * have neither, so a plain click goes there. The modified gestures are the
 * same ones, from the same place.
 */
export function RouteLink({ to, children, ...rest }: RouteLinkProps) {
  const navigate = useNavigate();
  const gesture = useLinkGesture();

  const handle = (event: MouseEvent<HTMLAnchorElement>) =>
    gesture(event, to, () => navigate(to));

  return (
    <Link to={to} onClick={handle} onAuxClick={handle} {...rest}>
      {children}
    </Link>
  );
}
