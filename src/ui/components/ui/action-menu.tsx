import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreHorizontal } from "lucide-react";
import { useT } from "@/i18n/useT";

interface ActionMenuProps {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  triggerLabel?: string;
  disabled?: boolean;
}

export function ActionMenu({
  children,
  align = "end",
  triggerLabel,
  disabled = false,
}: ActionMenuProps) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={triggerLabel ?? t("action", "openActions")}
          disabled={disabled}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
