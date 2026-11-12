import { Outlet, useRouterState } from "@tanstack/react-router";

import { CredentialsExpired } from "./CredentialsExpired";
import { useExpiredCredentials } from "./useExpiredCredentials";
import { DeepLinkBanner } from "./DeepLinkBanner";
import { ScopeMissingNotice, ScopeMissingPage } from "./ScopeMissing";
import { readsScope } from "./scoped-page";
import { NOTHING_MISSING, type ScopeMissing } from "@/hooks/useScopeMissing";
import { ObjectMenu } from "../-object/ObjectMenu";
import { ClusterFrontDoor } from "../../../-components/ClusterFrontDoor";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ScreenShareProvider } from "@/components/share/screen-share";
import { connectingTo, failedAt, useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/** The route's page, or the one screen that stands in for every page. */
export function PageArea({
  missing: scope = NOTHING_MISSING,
}: {
  /** The namespaces of the scope the cluster does not have. */
  missing?: ScopeMissing;
}) {
  const expired = useExpiredCredentials();
  const catchingUp = useScopeTabStore((s) => s.pendingHref !== null);
  const connecting = useClusterStore(connectingTo);
  const failed = useClusterStore(failedAt);
  // A held cluster coming back: the cache is still the last one's until it lands.
  const returning = useClusterStore((s) => s.pendingContext !== null);
  const scoped = useRouterState({
    select: (s) => readsScope(s.location.pathname),
  });

  // A refused session replaces the page: every list under it would draw its
  // empty state, which is how an expired token said a cluster had no pods.
  if (expired) return <CredentialsExpired expired={expired} />;
  // So does a connect in flight or failed, which each list's "no cluster" hid.
  if (connecting || failed) return <ClusterFrontDoor />;
  // A parked tab's cache is minutes old: hold it until its route has landed.
  if (catchingUp || returning) return <PageSkeleton className="p-0" />;
  // Nor is a namespace that is not there read as an empty one.
  if (scoped && scope.checking) return <PageSkeleton className="p-0" />;
  return (
    <>
      <DeepLinkBanner />
      <ObjectMenu />
      {scoped && scope.whole ? (
        <ScopeMissingPage missing={scope.missing} />
      ) : (
        <>
          {scope.missing.length > 0 && (
            <ScopeMissingNotice missing={scope.missing} />
          )}
          <ScreenShareProvider>
            <Outlet />
          </ScreenShareProvider>
        </>
      )}
    </>
  );
}
