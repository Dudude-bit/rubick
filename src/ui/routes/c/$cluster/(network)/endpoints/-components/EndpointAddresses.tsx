import { CopyableAddress } from "@/components/ui/copyable-value";
import { None } from "@/components/ui/none";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { EndpointAddress } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

/** Every address an Endpoints holds, each with whether it is ready. */
export function AddressesCell({
  addresses,
}: {
  addresses: { address: EndpointAddress; ready: boolean }[];
}) {
  const t = useT();
  if (addresses.length === 0) return <None />;
  const unready = addresses.some(({ ready }) => !ready);
  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          className={cn(
            "font-mono underline decoration-dotted underline-offset-2",
            unready ? "text-warn" : "text-fg-mut"
          )}
        >
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
                <span className="text-warn"> {t("count", "notReadyWord")}</span>
              )}
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
