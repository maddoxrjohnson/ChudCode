/**
 * status.ts: the line under Pi's editor that says whether the interviewer is wired up.
 *
 * Shown while the bridge is subscribed, so it is obvious which Pi session the
 * candidate's page is talking to, with a link to the session opened last. Plain string lines, the only widget content every
 * Pi mode honours. Follows pi-teach's src/status-widget.ts (Josh Noll, MIT); see
 * docs/ATTRIBUTION.md.
 */

import type { BridgeStatus } from "./bridge.ts";

export const WIDGET_KEY = "chudcode-interviewer";

export interface WidgetHost {
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  theme?: { fg(color: string, text: string): string };
}

export function statusLines(
  status: BridgeStatus,
  theme?: WidgetHost["theme"],
): string[] | undefined {
  if (!status.connected) return undefined;
  const paint = (color: string, text: string) => theme?.fg(color, text) ?? text;
  const lines = [
    `${paint("accent", "chudcode")} ${paint("dim", "interviewer connected on port")} ${paint("accent", String(status.port))}`,
  ];
  if (status.session) {
    lines.push(
      `${paint("accent", "chudcode")} ${paint("dim", "session")} ${status.session.title}: ${paint("accent", status.session.url)}`,
    );
  }
  return lines;
}

/** Draw the widget; a mode without widgets must not break the bridge. */
export function showStatus(ui: WidgetHost | null, status: BridgeStatus): void {
  if (!ui) return;
  try {
    ui.setWidget(WIDGET_KEY, statusLines(status, ui.theme), { placement: "belowEditor" });
  } catch {
    /* no widget support */
  }
}
