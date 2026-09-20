---
'electron-deck': minor
---

收缩公开的 `@experimental` 表面：删掉声明式装配子系统和几个从未有下游用过的便捷入口

这些字段和类型标了 `@experimental` 但一直没有真实下游用过，留着的成本是每加一条新契约就要多想一份兼容路径。这次直接删掉，改用已经在用的命令式入口。

删除：

- `DeckConfig.toolbar` / `ToolbarContribution` / `runtime.toolbarView` — toolbar 装配子系统整个下线。
- `DeckConfig.windows` / `WindowContribution` — 声明式窗口配置下线。
- `DeckConfig.menu` / `MenuContribution` / `MenuBuildContext` — 本来就只有类型没有实现，直接删。
- `DeckConfig.lifecycle` / `LifecycleContribution`（含 `beforeClose`）— 下线。
- `DeckConfig.setup` — 下线。
- `runtime.grants`、`runtime.layout.command`、`Grant.targetScope` — 全部下线。`electron-deck/host` 子路径下 `capability.ts` 的通用能力基础设施本身没动，只是 `deck-app.ts` 不再自带这层便捷包装和特权命令路由。
- `runtime.windows.get()` — 下线；`runtime.windows.all()` 的返回类型从松散类型收紧为 `DeckWindow[]`。
- `window-created` 事件的 `role` 从 `'main' | 'toolbar' | 'host'` 收窄为 `'main' | 'host'`（toolbar 子系统下线的连带）。监听里和 `'toolbar'` 比较的分支会报「比较无意义」，穷举 switch 也要去掉那一路。

等价替代：

- `backend.assemble(runtime)` 替代 `setup`——runtime 就绪后调用一次的装配钩子，返回值/抛错语义不变。
- `runtime.windows.create()`（命令式，在 `assemble` 里调）替代声明式 `windows` 配置——这条本来就是建子窗口的唯一路径，现在也是。
- `backend.onShutdown` 替代 `lifecycle.beforeClose`。注意两者不等价：`lifecycle.beforeClose` 原本有 10 秒默认超时，`backend.onShutdown` 没有超时，框架会一直 await 它。需要超时保护的宿主应在自己的 `onShutdown` 实现里用 `Promise.race` 之类自行限时。

两处契约修正（不是删除，是收紧）：

- `ViewCreateOptions.keepAlive` 的 `{ policy: 'lru', max }` 加了必填的 `group: string`——LRU 淘汰组以前靠隐式推断分组，现在必须显式指定。
- 一个 view 如果是通过 `placeIn`/`moveTo` 的非空 `anchor` 放置的（page-driven，位置由渲染进程驱动），host 现在调用公开的 `handle.applyPlacement()` 会抛错。没有 anchor 的 view 不受影响，仍可正常调用 `applyPlacement`。

顺带的类型收紧：`DeckViewHandle.placeIn`/`moveTo` 的窗口参数类型从单一类型改成 `BrowserWindow | DeckWindow`（两者现在都能直接传）。

**破坏性影响**：以上字段/方法在 TypeScript 里会直接报"不存在该属性"，不会静默失效。用到 `toolbar`/`windows`（声明式）/`menu`/`lifecycle`/`setup`/`grants`/`layout.command`/`targetScope`/`windows.get()` 的下游需要按上面的等价替代迁移；用到 `keepAlive` 的下游需要补上 `group` 字段；host 端对 page-driven view 调用 `applyPlacement` 的代码需要删除该调用（renderer 已经在驱动位置，host 侧调用本来就是多余的）。
