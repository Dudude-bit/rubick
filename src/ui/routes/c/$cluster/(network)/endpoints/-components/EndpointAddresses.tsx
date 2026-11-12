import { CopyableAddress } from "@/components/ui/copyable-value";
import { None } from "@/components/ui/none";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { EndpointAddress, EndpointsInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { PodsUnreadMark } from "./NotReadyPill";
import { useEndpointsPodsUnread } from "./pods-unread";

/** Every address an Endpoints holds, each with whether it is ready; one not ready is neutral with the not-read mark where its Service's pods were not read. */
export function AddressesCell({
  endpoints,
  addresses,
}: {
  endpoints: EndpointsInfo;
  addresses: { address: EndpointAddress; ready: boolean }[];
}) {
  const t = useT();
  const podsUnread = useEndpointsPodsUnread(endpoints);
  if (addresses.length === 0) return <None />;
  const unready = addresses.some(({ ready }) => !ready);
  const notReadyTone = podsUnread ? "text-fg-mut" : "text-warn";
  return (
    <Tooltip disableHoverableContent={false}>
      <TooltipTrigger>
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono underline decoration-dotted underline-offset-2",
            unready ? notReadyTone : "text-fg-mut"
          )}
        >
          {unready && podsUnread && <PodsUnreadMark />}
          {addresses.length}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          {addresses.map(({ address, ready }, i) => (
            <div key={i}>
              <CopyableAddress
                value={address.ip}
                label={t("columns", "address")}
              />
              {!ready && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 pl-1",
                    notReadyTone
                  )}
                >
                  {podsUnread && <PodsUnreadMark />}
                  {t("count", "notReadyWord")}
                </span>
              )}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
