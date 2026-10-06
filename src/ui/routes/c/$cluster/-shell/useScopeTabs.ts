/**
 * The wiring that makes a scope tab behave like a browser tab: the router
 * bridge, the cache eviction that keeps a returning tab honest, and the
 * keyboard. Mounted once, by `Layout`.
 *
 * @module hooks/useScopeTabs
 */

import { useSettingsStore } from "@/stores/settingsStore";
import { useEffect, useRef } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useLocationHref } from "@/hooks/useLocationHref";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/**
 * The route the bridge has asked the router for and not yet heard back on.
 * Outside the hook because the layout that mounts it unmounts at the front
 * door, and the ask has to survive that to be asked only once.
 */
let delivering: string | null = null;

const hrefOf = (location: { pathname: string; search: string }) =>
  `${location.pathname}${location.search}`;

export function useScopeTabs(): void {
  const navigate = useNavigate();
  const router = useRouter();
  const href = useLocationHref();
  const queryClient = useQueryClient();

  const pendingHref = useScopeTabStore((s) => s.pendingHref);
  const activeId = useScopeTabStore((s) => s.activeId);
  const contexts = useClusterStore((s) => s.contexts);
  const contextSwitches = useClusterStore((s) => s.contextSwitches);

  // Router -> store. Every navigation belongs to the tab it happened in,
  // the way a browser tab tracks the page.
  useEffect(() => {
    useScopeTabStore.getState().recordHref(href);
  }, [href]);

  // Store -> router. An activation asks for a route; this delivers it and
  // reports back, which is what re-opens the outlet. Asked once, and settled
  // wherever the router lands: a redirect, or the front door sending the
  // window on to a cluster, never arrives at the address asked for, and
  // asking again would chase it forever.
  useEffect(() => {
    if (pendingHref === null) return;
    if (pendingHref === href) {
      useScopeTabStore.getState().routeSettled();
      return;
    }
    if (delivering === pendingHref) return;
    delivering = pendingHref;
    const landed = () => {
      if (delivering === pendingHref) delivering = null;
      const store = useScopeTabStore.getState();
      if (store.pendingHref !== pendingHref) return;
      store.routeSettled();
      const { pathname, searchStr } = router.state.location;
      store.recordHref(`${pathname}${searchStr}`);
    };
    const replace = useScopeTabStore.getState().pendingReplace;
    void navigate({ href: pendingHref, replace }).then(landed, landed);
  }, [pendingHref, href, navigate, router]);

  // The window keeps one history for every tab. A route pushed is remembered
  // by the tab it was pushed in, and Back, the arrow's or the mouse's, walks
  // that tab's own: the window's is put back where it was before anything
  // renders the other tab's route, which would also connect its cluster.
  useEffect(() => {
    let previous = hrefOf(router.history.location);
    const unsubscribe = router.history.subscribe(({ location, action }) => {
      const next = hrefOf(location);
      if (action.type === "PUSH")
        useScopeTabStore.getState().pushed(previous, next);
      previous = next;
    });
    const unblock = router.history.block({
      enableBeforeUnload: false,
      blockerFn: ({ action, currentLocation, nextLocation }) => {
        if (action === "PUSH" || action === "REPLACE") return false;
        const backwards =
          nextLocation.state.__TSR_index < currentLocation.state.__TSR_index;
        window.addEventListener(
          "popstate",
          () => {
            if (backwards) useScopeTabStore.getState().goBack();
          },
          { once: true }
        );
        return true;
      },
    });
    return () => {
      unsubscribe();
      unblock();
    };
  }, [router]);

  // A route that names an object names it in one cluster; the list it came
  // from is the same list anywhere.
  useEffect(() => {
    if (contextSwitches === 0) return;
    useScopeTabStore
      .getState()
      .retargetAfterSwitch(useClusterStore.getState().currentContext);
  }, [contextSwitches]);

  // A lost tab takes the cluster a connect started from it lands on — not
  // the one still open when it was activated, which is being dropped.
  useEffect(() => {
    let startedOn: { attempt: number; tab: string } | null = null;
    return useClusterStore.subscribe((state, prev) => {
      if (
        state.connectionAttemptId !== prev.connectionAttemptId &&
        state.pendingContext
      ) {
        const { tabs, activeId } = useScopeTabStore.getState();
        const active = tabs.find((tab) => tab.id === activeId);
        startedOn = active?.missing
          ? { attempt: state.connectionAttemptId, tab: active.id }
          : null;
      }
      if (
        startedOn &&
        state.isConnected &&
        !prev.isConnected &&
        state.connectionAttemptId === startedOn.attempt &&
        state.currentContext
      ) {
        const tabs = useScopeTabStore.getState();
        if (tabs.activeId === startedOn.tab)
          tabs.adoptConnected(state.currentContext);
        startedOn = null;
      }
    });
  }, []);

  // Everything cached belonged to the connection the parked tab no longer
  // has, so none of it may be shown as live. Resource query keys do not
  // carry the context either — `["pods","default"]` is the same entry in
  // every cluster — so a filtered eviction would be a guess. Dropping the
  // lot costs a refetch and buys the guarantee that the numbers on screen
  // came from the cluster the tab names. The outlet is shut while this
  // runs, so the pages that reappear mount against an empty cache and show
  // their own loading state rather than a minutes-old count. Reset rather
  // than removed: the shell never unmounts, and its counts would go on
  // polling an evicted entry on their own schedule beside a fresh list.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void queryClient.resetQueries();
  }, [activeId, queryClient]);

  // A tab outlives the kubeconfig that made it, so what is on disk has to
  // be checked against what is actually there before it is trusted.
  const resumed = useRef(false);
  useEffect(() => {
    if (contexts.length === 0) return;
    const store = useScopeTabStore.getState();
    store.reconcileContexts(contexts.map((ctx) => ctx.name));
    if (resumed.current) return;
    resumed.current = true;
    // The restored tab is the workspace: its namespace scope, which the
    // route's own connect knows nothing about, is applied once there is a
    // kubeconfig to apply it under.
    void useScopeTabStore.getState().resumeActive();
  }, [contexts]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useScopeTabStore.getState();
      // Settings is an opaque layer over the whole window, so a tab opened,
      // closed or switched behind it happens where the reader cannot see it.
      // This listener is on `window` and a Radix modal does not stop it, so
      // the layer stands aside rather than being stepped over: the shortcut
      // still does what it says, and the reader watches it happen.
      const reveal = () => {
        const settings = useSettingsStore.getState();
        if (settings.open) settings.closeSettings();
      };
      // Ctrl+Tab on both platforms — Cmd+Tab is the macOS app switcher and
      // never reaches a window, which is why browsers use Ctrl there too.
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        reveal();
        void store.activateRelative(event.shiftKey ? -1 : 1);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        reveal();
        void store.openTab();
        return;
      }
      if (key === "w") {
        event.preventDefault();
        reveal();
        void store.closeTab(store.activeId);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        // 9 is the last tab, however many there are — the browser rule.
        reveal();
        void store.activateIndex(
          event.key === "9" ? -1 : Number(event.key) - 1
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
