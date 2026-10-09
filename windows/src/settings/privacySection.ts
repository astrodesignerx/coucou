// Privacy detail: truthful statements about data the app already handles,
// and pointers to the controls that own each choice. No toggles live here:
// every control keeps its single owner in Voice, Brain or Connections.

import { h } from "../views/dom";

export function privacySection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Privacy" })),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
    h("div", {
      class: "hint",
      text: "API keys and tokens are stored in the Windows Credential Manager rather than in settings files.",
    }),
    h("div", {
      class: "hint",
      text: "Hook changes always show a preview with a backup first, and only write after your click in Connections.",
    }),
    h("div", {
      class: "hint",
      text: "Voice, the wake word, local memory and Jev routing stay off until you turn them on in Voice and Brain.",
    }),
    h("div", {
      class: "hint",
      text: "When Jev routing is on, only the current request plus short capability names are sent to the configured Jev endpoint. Routing receipts kept in History hold no request text.",
    }),
  );
}
