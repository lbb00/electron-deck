---
'electron-deck': minor
---

四个 API 改名 + `draggable` 拆分为两个字段，另修了 `OverlayPanel.reposition()` 一个违反自身文档的行为。

**改名（旧名 → 新名，全部破坏性，无别名）**：

- `electron-deck/layout`：`validateTree` → `collectTreeProblems`
- `electron-deck/layout`：`cleanSnapshot` → `authorizeSnapshot`
- `electron-deck/layout`：`dispatchOps` → `applyReconciledPlacements`
- `electron-deck/client`：`LayoutClientDeps.requestFrame` / `cancelFrame` → `schedulePublish` / `cancelScheduledPublish`（`createDeckLayoutClient` 的注入点；`PlacementPublisherDeps` 同名字段同步改名）

下游只要直接调用了这些符号名或注入了这些 deps 字段，替换成新名即可。

有一个例外要注意：**只注入 cancel、不注入 schedule 的写法不再生效**。改名前 `cancelFrame` 单独注入会被采纳；现在只有同时注入 `schedulePublish` 时，`cancelScheduledPublish` 才会被使用，单独注入 cancel 会被忽略（换成一个空函数）。这是有意的——frame id 属于生成它的调度器，拿别人的 cancel 去取消默认调度器发的 id 可能误伤同进程里另一个 publisher。测试替身里常见只替 cancel 的写法，改名时一并把 schedule 也注入上。

**`PanelCapabilities.draggable` 拆分为两个字段**：

之前 `draggable` 同时控制「这个面板能不能被拖起来」和「别人能不能停靠到这个面板所在的组」。现在拆开：

- `draggable?: boolean` —— 只管前者：面板的 tab 能不能被拖起来。
- `acceptsDrops?: boolean`（新增） —— 只管后者：以这个面板为 active tab 的组，能不能接受别的面板停靠/分屏进来。

**回落规则（需要下游知道）**：`acceptsDrops` 省略时回落到 `draggable`，再回落到 `true`（即
`acceptsDrops ?? draggable ?? true`）。这样现有只写了 `draggable: false` 的注册不用改也
不会变成「可以被停靠」——如果你注册面板时写过 `draggable: false` 并且依赖它同时挡住停靠，
不用动；如果你现在想让它继续禁止被拖起，但允许别人停靠进来，显式加一个 `acceptsDrops: true`。

**`OverlayPanel.reposition()` 修了一个 no-op 判断**：之前只检查原生 view 存不存在，`prepare()`
之后或 `hide()` 之后调用会把面板重新显示出来，跟它自己的文档「未显示时应为 no-op」矛盾。现在
按 `wantsVisible` 判断，`prepare()`/`hide()` 之后调用 `reposition()` 真正是 no-op 了。如果有代码
依赖了这个 bug（在 hide 之后靠 reposition 让面板重新出现），需要改成显式调用 `show()`。
