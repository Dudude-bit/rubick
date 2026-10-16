import type { EndpointsInfo } from "@/generated/types";
import type { ServiceBackingRead } from "@/hooks/useServiceBacking";
import type { T } from "@/i18n/useT";
import {
  podsUnreadOf,
  serviceHealthOf,
  serviceHealthWords,
  type ServiceHealth,
} from "@/lib/service-health";
import { useBackingRead } from "../../-components/service-backing";

/** Whether the Service an Endpoints object belongs to has its pods unread, as its verdict on the list reads it. */
export const endpointsPodsUnread = (
  read: ServiceBackingRead | null | undefined,
  endpoints: EndpointsInfo
) => podsUnreadOf(read?.published(endpoints.namespace, endpoints.name));

export const useEndpointsPodsUnread = (endpoints: EndpointsInfo) =>
  endpointsPodsUnread(useBackingRead(), endpoints);

/** The verdict of the Service behind an Endpoints object that lists nothing, once its read has answered. */
export function emptyEndpointsVerdict(
  read: ServiceBackingRead | null | undefined,
  endpoints: EndpointsInfo,
  t: T
) {
  const published = read?.published(endpoints.namespace, endpoints.name);
  if (!published) return null;
  const health = serviceHealthOf(
    { type: "", selectorless: false },
    published,
    null
  );
  return { state: health.state, words: serviceHealthWords(health, t) };
}

/** Whether its own verdict stands in for "no endpoints": only the ones no fault explains. */
export const WAITS: Record<ServiceHealth["state"], boolean> = {
  idle: true,
  comingUp: true,
  podsUnread: true,
  ready: false,
  partly: false,
  draining: false,
  noneReady: false,
  noEndpoints: false,
  shut: false,
  externalName: false,
  selectorless: false,
  byHand: false,
  unknown: false,
};
