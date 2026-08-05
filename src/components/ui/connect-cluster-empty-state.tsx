interface ConnectClusterEmptyStateProps {
  resourceLabel?: string;
}

export function ConnectClusterEmptyState({
  resourceLabel,
}: ConnectClusterEmptyStateProps) {
  const message = resourceLabel
    ? `Connect to a cluster to view ${resourceLabel}`
    : "Connect to a cluster";

  return (
    <div className="flex h-full items-center justify-center text-xs text-fg-mut">
      {message}
    </div>
  );
}
