import { useQuery } from "@tanstack/react-query";

import { EmptyPage } from "../../../-components/NotFound";
import { catalogQuery, type Served } from "./served";
import { ReadAgain } from "@/components/ui/read-again";
import { useT } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";

/** A kind discovery did not list, or could not be asked about, with a way to ask again: it may have been installed since. */
export function Unserved({
  served,
  resource,
}: {
  served: Extract<Served, { state: "absent" | "unknown" }>;
  resource: string;
}) {
  const t = useT();
  const isConnected = useClusterStore((state) => state.isConnected);
  const catalog = useQuery({ ...catalogQuery(), enabled: isConnected });
  const again = (
    <ReadAgain error={catalog.error} onRetry={() => void catalog.refetch()} />
  );
  return served.state === "absent" ? (
    <EmptyPage
      title={t("empty", "notServed", { resource })}
      body={t("empty", "notServedBody")}
    >
      {again}
    </EmptyPage>
  ) : (
    <EmptyPage
      title={t("empty", "discoveryUnread", { resource })}
      body={t("empty", "discoveryUnreadBody", { error: served.error })}
    >
      {again}
    </EmptyPage>
  );
}
