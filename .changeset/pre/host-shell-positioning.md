---
'electron-deck': patch
---

Describe the package and its keywords as a host-shell framework

The previous `description` mentioned only “dockable panels”, presenting the package as a docking layout library. Docking is one part of it: multi-window orchestration, native `WebContentsView` instances following the DOM, overlays and popouts, and cross-process IPC are its main purpose. `/layout` and `/dock-react` provide a separate, orthogonal interface without an Electron dependency, usable independently in browser projects.

The npm page and search results read these fields directly, so they shape a consumer's first impression. Both README summaries and the banner text use the same description.

Add `host-shell`, `framework`, `multi-window`, and `ipc` to the keywords.
