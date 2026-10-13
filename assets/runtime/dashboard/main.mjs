/** The dashboard: server-rendered; reloads itself when a session starts or ends. */

import { connectEvents } from "../shared/events.mjs";
import { initTheme } from "../shared/theme.mjs";

initTheme();

connectEvents("/api/events?scope=dashboard", {
  reload: () => window.location.reload(),
});
