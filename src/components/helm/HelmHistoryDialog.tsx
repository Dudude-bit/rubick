import { RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { HelmRelease, HelmRevision } from "@/generated/types";

interface HelmHistoryDialogProps {
  release: HelmRelease;
  history: HelmRevision[];
  isLoading: boolean;
  helmCliAvailable: boolean;
  onClose: () => void;
  onRollback: (revision: number) => void;
}

export function HelmHistoryDialog({
  release,
  history,
  isLoading,
  helmCliAvailable,
  onClose,
  onRollback,
}: HelmHistoryDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-lg w-full max-w-2xl max-h-[80vh] overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">History: {release.name}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close history"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="p-4 overflow-y-auto max-h-[60vh]">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8">
              Loading history...
            </div>
          ) : history.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              No history found
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Rev</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-left p-2">Chart</th>
                  <th className="text-left p-2">Updated</th>
                  <th className="text-left p-2">Description</th>
                  <th className="text-right p-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((rev) => (
                  <tr key={rev.revision} className="border-b last:border-0">
                    <td className="p-2 font-medium">{rev.revision}</td>
                    <td className="p-2">
                      <StatusBadge status={rev.status} />
                    </td>
                    <td className="p-2 text-muted-foreground">{rev.chart}</td>
                    <td className="p-2 text-muted-foreground">
                      {rev.updated
                        ? new Date(rev.updated).toLocaleString()
                        : "-"}
                    </td>
                    <td className="p-2 text-muted-foreground truncate max-w-[150px]">
                      {rev.description || "-"}
                    </td>
                    <td className="p-2 text-right">
                      {rev.revision < release.revision && helmCliAvailable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRollback(rev.revision)}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Rollback
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
