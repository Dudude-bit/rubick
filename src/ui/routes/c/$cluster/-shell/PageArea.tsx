import { Outlet } from "@tanstack/react-router";

import { CredentialsExpired } from "./CredentialsExpired";
import { useExpiredCredentials } from "./useExpiredCredentials";
import { DeepLinkBanner } from "./DeepLinkBanner";
import { ObjectMenu } from "../-object/ObjectMenu";
import { ClusterFrontDoor } from "../../../-components/ClusterFrontDoor";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ScreenShareProvider } from "@/components/share/screen-share";
import { connectingTo, failedAt, useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/** The route's page, or the one screen that stands in for every page. */
export function PageArea({ page }: { page?: React.ReactNode }) {
  const expired = useExpiredCredentials();
  const catchingUp = useScopeTabStore((s) => s.pendingHref !== null);
  const connecting = useClusterStore(connectingTo);
  const failed = useClusterStore(failedAt);

  // A refused session replaces the page: every list under it would draw its
  // empty state, which is how an expired token said a cluster had no pods.
  if (expired) return <CredentialsExpired expired={expired} />;
  // So does a connect in flight or failed, which each list's "no cluster" hid.
  if (!page && (connecting || failed)) return <ClusterFrontDoor />;
  // A parked tab's cache is minutes old: hold it until its route has landed.
  if (catchingUp) return <PageSkeleton className="p-0" />;
  return (
    <>
      <DeepLinkBanner />
      <ObjectMenu />
      <ScreenShareProvider>{page ?? <Outlet />}</ScreenShareProvider>
    </>
  );
}
