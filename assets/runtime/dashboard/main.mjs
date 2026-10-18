/**
 * The dashboard: server-rendered; reloads itself when a session starts or ends, and
 * follows a press of Next problem to the session the interviewer opens for it.
 */

import { connectEvents } from "../shared/events.mjs";
import { createNextUp } from "../shared/next-up.mjs";
import { initTheme } from "../shared/theme.mjs";

initTheme();
const next = createNextUp();

connectEvents("/api/events?scope=dashboard", {
  reload: () => {
    if (!next.navigating) window.location.reload();
  },
  presence: (payload) => next.presence(payload.connected),
  next: (payload) => next.pending(payload.pending),
  next_session: (payload) => next.open(payload),
});
