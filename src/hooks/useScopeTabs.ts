/**
 * The wiring that makes a scope tab behave like a browser tab: the router
 * bridge, the cache eviction that keeps a returning tab honest, and the
 * keyboard. Mounted once, by `Layout`.
 *
 * @module hooks/useScopeTabs
 */

import { useSettingsStore } from "@/stores/settingsStore";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

export function useScopeTabs(): void {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const href = `${pathname}${search}`;
  const queryClient = useQueryClient();

  const pendingHref = useScopeTabStore((s) => s.pendingHref);
  const activeId = useScopeTabStore((s) => s.activeId);
  const contexts = useClusterStore((s) => s.contexts);

  // Router -> store. Every navigation belongs to the tab it happened in,
  // the way a browser tab tracks the page.
  useEffect(() => {
    useScopeTabStore.getState().recordHref(href);
  }, [href]);

  // Store -> router. An activation asks for a route; this delivers it and
  // reports back, which is what re-opens the outlet.
  useEffect(() => {
    if (pendingHref === null) return;
    if (pendingHref !== href) {
      navigate(pendingHref);
      return;
    }
    useScopeTabStore.getState().routeSettled();
  }, [pendingHref, href, navigate]);

  // Everything cached belonged to the connection the parked tab no longer
  // has, so none of it may be shown as live. Resource query keys do not
  // carry the context either — `["pods","default"]` is the same entry in
  // every cluster — so a filtered eviction would be a guess. Dropping the
  // lot costs a refetch and buys the guarantee that the numbers on screen
  // came from the cluster the tab names. The outlet is shut while this
  // runs, so the pages that reappear mount against an empty cache and show
  // their own loading state rather than a minutes-old count.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    queryClient.removeQueries();
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
    // The kubeconfig's own current context auto-connects on load; the
    // restored tab is the workspace and outranks it.
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
