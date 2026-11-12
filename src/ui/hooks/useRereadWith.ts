import { useEffect } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Reads `follower` again whenever `source` answers with a changed object, so
 * an object's YAML moves with its Overview rather than on a poll of its own.
 */
export function useRereadWith(source: QueryKey, follower: QueryKey) {
  const client = useQueryClient();
  const sourceHash = hashKey(source);
  const followerHash = hashKey(follower);
  useEffect(() => {
    const followerKey = JSON.parse(followerHash) as QueryKey;
    let last = client.getQueryCache().get(sourceHash)?.state.data;
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== sourceHash) {
        return;
      }
      const data = event.query.state.data;
      if (data === last) return;
      const seen = last !== undefined;
      last = data;
      if (seen) {
        void client.invalidateQueries({ queryKey: followerKey, exact: true });
      }
    });
  }, [client, sourceHash, followerHash]);
}
