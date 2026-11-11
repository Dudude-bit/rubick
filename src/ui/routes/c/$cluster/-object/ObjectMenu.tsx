import { useEffect, useState } from "react";

import { peekTargetOfHref } from "@/hooks/usePeek";
import { builtInKindOf, clusterOf } from "@/lib/links";
import type { ResourceKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
import type { Listed } from "../-list/RowMenu";
import { useRowMenu } from "../-list/useRowMenu";

type Linked = Listed & { href: string; here: boolean };

const hrefOfRow = (row: Linked) => row.href;
const peekOfRow = (row: Linked) =>
  row.here ? peekTargetOfHref(row.href) : null;

/**
 * The right-click menu of an object link: the list row's menu, with the
 * object's actions, so a pod in a workload's Pods tab restarts as it does in
 * the Pods list. The webview's own menu copied `http://tauri.localhost/...`.
 */
export function ObjectMenu() {
  const [kind, setKind] = useState<ResourceKind | null>(null);
  const menu = useRowMenu<Linked>({
    kind,
    getRowHref: hrefOfRow,
    getRowPeek: peekOfRow,
  });
  const { open } = menu;

  // Taken from the store as it is asked for, and the ask consumed.
  useEffect(
    () =>
      useObjectMenuStore.subscribe(({ target, close }) => {
        if (!target) return;
        const object = peekTargetOfHref(target.to);
        // Its actions and its peek act on the window's cluster, so an object
        // of another one is offered only what its own address can do.
        const here =
          clusterOf(target.to) === useClusterStore.getState().currentContext;
        setKind(here && object ? builtInKindOf(object) : null);
        open(
          {
            name: target.name,
            namespace: object?.namespace,
            href: target.to,
            here,
          },
          { x: target.x, y: target.y }
        );
        close();
      }),
    [open]
  );

  return menu.element([]);
}
