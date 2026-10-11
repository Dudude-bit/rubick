import type { EndpointsInfo } from "@/generated/types";
import type { ServiceBackingRead } from "@/hooks/useServiceBacking";
import { podsUnreadOf } from "@/lib/service-health";
import { useBackingRead } from "../../-components/service-backing";

/** Whether the Service an Endpoints object belongs to has its pods unread, as its verdict on the list reads it. */
export const endpointsPodsUnread = (
  read: ServiceBackingRead | null | undefined,
  endpoints: EndpointsInfo
) => podsUnreadOf(read?.published(endpoints.namespace, endpoints.name));

export const useEndpointsPodsUnread = (endpoints: EndpointsInfo) =>
  endpointsPodsUnread(useBackingRead(), endpoints);
