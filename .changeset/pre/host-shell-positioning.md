---
"electron-deck": patch
---

包描述和 keywords 改用 host shell 口径

`description` 原来只说「dockable panels」，把这个包描述成一个停靠布局库。实际上 dock 只是它的一个面：多窗口编排、原生 `WebContentsView` 跟住 DOM、浮层与 popout、跨进程 IPC 才是主体；`/layout` 和 `/dock-react` 是另一个正交的、不依赖 Electron 的面，纯浏览器项目能单独用。

npm 页面和搜索结果直接读这两个字段，所以它们决定了别人第一眼以为这个包是干什么的。两个 README 的摘要行和 banner 文案也已经对齐同一套说法。

keywords 补上 `host-shell`、`framework`、`multi-window`、`ipc`。
