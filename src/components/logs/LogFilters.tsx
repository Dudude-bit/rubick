import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ActiveFilter } from "./types";

interface LogFiltersProps {
  filters: ActiveFilter[];
  onRemoveFilter: (filter: ActiveFilter) => void;
}

export function LogFilters({ filters, onRemoveFilter }: LogFiltersProps) {
  if (filters.length === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-hair px-2 py-1">
      <span className="text-xs text-fg-fnt">Filters:</span>
      <div className="flex flex-wrap gap-1">
        {filters.map((filter, index) => (
          <Badge
            key={`${filter.type}-${filter.key}-${filter.value}-${index}`}
            variant="secondary"
            className="flex cursor-pointer items-center gap-1 hover:bg-err/[0.16] hover:text-err"
            onClick={() => onRemoveFilter(filter)}
          >
            <span>{filter.label}</span>
            <X className="h-3 w-3" />
          </Badge>
        ))}
      </div>
    </div>
  );
}
