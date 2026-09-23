---
'electron-deck': patch
---

`electron` peer 依赖从 `^43.2.0` 放宽到 `>=30.5.1`

框架用到的 Electron API（`WebContentsView`、`View.addChildView/removeChildView/children`、`BaseWindow.contentView`、`senderFrame`）从 Electron 30 起都有，原来的范围把 30–42 的应用挡在外面。30.5.1 是实测通过的最低版本：真实 Electron e2e 全部通过，重复 `addChildView` 把视图移到最上层的行为也与合框的假设一致。CI 现在同时在这个最低版本上跑 e2e。

不是破坏性变更：原来能装的版本现在依然能装。
