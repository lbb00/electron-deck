---
'electron-deck': patch
---

Broaden the `electron` peer dependency from `^43.2.0` to `>=30.5.1`

The Electron APIs used by the framework (`WebContentsView`, `View.addChildView/removeChildView/children`, `BaseWindow.contentView`, and `senderFrame`) have been available since Electron 30. The previous range excluded applications on versions 30–42. Version 30.5.1 is the lowest version verified by the real Electron E2E suite; repeatedly calling `addChildView` also moves the view to the top as the compositor expects. CI now runs E2E on this minimum version as well.

This is not a breaking change: every previously supported version remains supported.
