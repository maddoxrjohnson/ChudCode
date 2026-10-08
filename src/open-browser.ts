/**
 * open-browser.ts: open a URL in the default browser, best effort.
 *
 * Opening the browser is a convenience, so failures are swallowed and the caller
 * still prints the URL.
 */

import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no opener available */
  }
}
