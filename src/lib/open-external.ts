import { open } from "@tauri-apps/plugin-shell";

import { toast } from "@/components/ui/use-toast";

/**
 * Hand a web address to the system browser.
 *
 * The webview has no second window, so following a real `href` would navigate
 * the app away from itself; every outward link in this app is an anchor with
 * the true destination and an intercepted gesture, and this is what the
 * gesture does.
 *
 * There may be no browser to hand it to — a bare container, a sandbox. Saying
 * nothing would look like a dead control, so the address goes where the reader
 * can still use it and the toast says which it is.
 */
export async function openExternal(url: string, site: string): Promise<void> {
  try {
    await open(url);
  } catch {
    const copied = await navigator.clipboard
      .writeText(url)
      .then(() => true)
      .catch(() => false);
    toast({
      title: "Could not open your browser",
      description: copied
        ? `The ${site} address is on your clipboard instead: ${url}`
        : `${site} has it at ${url}`,
      variant: "destructive",
    });
  }
}
