// Dev-only fixture: the REAL production Island (header, lead mascot, views)
// with the inline Settings view open. Served by `vite dev` only; vite build
// never bundles this page (inputs are index.html + settings.html alone), so
// it cannot reach production. Bridge calls resolve null in a plain browser,
// so every section renders its offline/empty state: fictional data only, no
// private data, no native calls.
import "./style.css";
import { Sound } from "./core/sound";
import { State } from "./core/state";
import { Island } from "./island/island";
import { parseHubCategory } from "./settings/hub";

const root = document.getElementById("root");
if (root) {
  void Sound.preload();
  const island = new Island(root);
  State.loadIntegrationTasks();
  island.applySettings();
  island.launch();
  // Open the inline hub like the header gear does, optionally deep-linked
  // (?room=voice). Unknown rooms fall back to the hub home.
  const room = parseHubCategory(new URLSearchParams(window.location.search).get("room"));
  if (room) island.openSettingsCategory(room);
  else island.showSettingsHome();
  // Keep the island posed for the screenshot: headless Chrome has no cursor,
  // and the settings view already suspends hover auto-close.
  (window as unknown as { __island?: Island }).__island = island;
}
