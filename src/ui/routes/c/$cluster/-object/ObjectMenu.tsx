import { useEffect, useState } from "react";

import { peekTargetOfHref } from "@/hooks/usePeek";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
import type { Listed } from "../-list/RowMenu";
import { useRowMenu } from "../-list/useRowMenu";

type Linked = Listed & { href: string };

const hrefOfRow = (row: Linked) => row.href;

/**
 * The right-click menu of an object link: the list row's menu, with the
 * object's actions, so a pod in a workload's Pods tab restarts as it does in
 * the Pods list. The webview's own menu copied `http://tauri.localhost/...`.
 */
export function ObjectMenu() {
  const [kind, setKind] = useState<string | null>(null);
  const menu = useRowMenu<Linked>({ kind, getRowHref: hrefOfRow });
  const { open } = menu;

  // Taken from the store as it is asked for, and the ask consumed.
  useEffect(
    () =>
      useObjectMenuStore.subscribe(({ target, close }) => {
        if (!target) return;
        const object = peekTargetOfHref(target.to);
        setKind(object?.crd ? null : (object?.kind ?? null));
        open(
          { name: target.name, namespace: object?.namespace, href: target.to },
          { x: target.x, y: target.y }
        );
        close();
      }),
    [open]
  );

  return menu.element([]);
}
