# electron-deck

## 1.0.0-beta.0

### Major Changes

- 55be4ce: Start the `1.0.0` beta series. This release includes the public API and native-view lifecycle changes described in the accompanying Changesets; existing 0.2.x consumers should review the migration notes before upgrading.

### Minor Changes

- f3c01bd: 修复：面板换位之后原生视图卡在旧位置不动

  现象：把面板拖到另一个位置（或另一个窗口）松手后，原生视图有时停在松手前的矩形上不再跟随；如果卡住的是一帧「隐藏」，该消失的视图会一直显示。之后怎么调窗口大小都不恢复，要等槽位矩形再次变化、页面导航或关窗才好。

  原因：主进程收到一帧 placement 时，先把「视图现在在哪」记进账本，再下发给视图。但视图在 `moveTo` 迁移途中会拒收这一帧，原生 attach 失败时也会抛错——两种情况下这一帧都没生效，账本却已经记成生效了。而 reconcile 是电平触发的，只在「想要的」和「记录的」不一致时才产出操作；账本记错之后，后面每一帧内容相同就都是零操作，这一帧永远补不回来。

  改法：下发之后再提交账本，被拒收或抛错的视图把账本回滚成上一帧的值。同一帧下次再来就会重新判定为有差异并重试。

  **破坏性，在 `electron-deck/layout` 的公开导出面上**：

  - `applyReconciledPlacements` 的 sink 类型从 `(p: Placement) => void` 改成 `(p: Placement) => boolean`，返回这一帧是否被接受；抛错等价于返回 `false`。
  - `applyReconciledPlacements` 本身的返回值从 `void` 改成 `Set<string>`，内容是本轮被拒收的 viewId。调用方要据此回滚自己的 `state.actual`，否则同样会留下记错的账本。
  - `electron-deck/main` 导出的 `ViewHandle.applyPlacement` 返回值同样是 `boolean`。自己实现 `ViewHandle` 的调用方（测试替身、适配层）需要补上返回值；只调用不实现的不受影响。

  根入口的 `DeckViewHandle.applyPlacement` 签名没变，仍然返回 handle 本身用于链式调用。

- 0666b26: 去掉 `simulator` 概念：wire 只保留 `host` 调用类型，`DeckConfig.simulatorApis` 一并删除

  `InvokeKind` 原来是 `'host' | 'simulator'`，配套在 `WireTransportDeps` 上有一个必填的 `invokeSimulator` seam，`WireTransport.handleInvoke` 会把 `kind: 'simulator'` 的请求路由到它。根入口的 `DeckConfig.simulatorApis` 是这条路的配置端：宿主在这里挂一组处理函数，框架把它们投影成渲染进程里的全局 API。

  `simulator` 是某个下游宿主的业务概念——那个宿主要在同一条 wire 上并行跑一套模拟器 API。electron-deck 自己没有任何代码产生或消费这个 kind，它只是被框架的公开协议固化下来了。协议里多出一个框架不理解语义的分支，宿主只能按这一种形状去组织自己的第二套 API；要第三套就没地方放。宿主本来就可以在 `invokeHost` 里按自己的命名约定分发，不需要框架给它留槽。

  现在 `InvokeKind = 'host'`，`invokeSimulator` 从 `WireTransportDeps` 删掉，dispatch 分支一并移除；`DeckConfig.simulatorApis` 和它的类型 `SimulatorApiHandler` 也删掉——这个字段标着 `@experimental`，只有 `examples/` 和实验脚本设过它，`backend` 装配从不读它。

  **破坏性**，四处都在公开导出面上：

  - `electron-deck/host` 导出的 `WireTransportDeps` 少了 `invokeSimulator` 字段。还在传这个字段的调用方会被 TypeScript 的多余属性检查报错，不会静默失效。
  - `electron-deck/preload` 导出的 `InvokeRequest.kind` 收窄成 `'host'`，写 `kind: 'simulator'` 的地方类型不再通过。
  - 根入口不再导出 `SimulatorApiHandler`，`DeckConfig` 不再接受 `simulatorApis`。传了这个字段的配置同样会被多余属性检查报错。
  - 根入口的 `Runtime.call` 不再有 `simulator(name, ...args)` 方法。调用 `runtime.call.simulator()` 会报属性不存在，改成 `runtime.call.host()`。

  运行时没有变脆：漏网的 `kind: 'simulator'` 请求落到原有的 `UnknownKind` 分支，返回结构化的 `InvokeFailure`，不会抛也不会崩。

  下游要保留这套 API 的，两端各改一处：

  - 配置端把处理函数从 `simulatorApis` 挪到 `hostServices`。两者走的是同一条 invoke channel、同一套 sender 准入（trusted webContents + main frame，检查都发生在 kind 分派之前），所以挪过去不会放宽也不会收紧权限，名字上也没有额外限制。注意 `layout.` 这个前缀过去是保留的——`hostServices` 会拒绝它，因为那是特权命令的名字空间。本版把特权命令路由整条下线（`runtime.layout.command` 和它背后的 ControlBus 接线都删了，见另一条 changeset），这条保留也就一并取消：`hostServices` 现在接受任何名字，包括 `layout.` 开头的，它们只是普通的 host service，够不到任何特权路径。
  - 调用端把 `kind: 'simulator'` 改成 `kind: 'host'`。自己有多套 API 要分流的，在 `invokeHost` 里按名字前缀分。

- 0666b26: 四个 API 改名 + `draggable` 拆分为两个字段，另修了 `OverlayPanel.reposition()` 一个违反自身文档的行为。

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

- 0666b26: debugTap：`DebugTapEntry.appSessionId` 改名为 `sessionId`

  这个字段原来叫 `appSessionId`，其中 `appSession` 是某个下游宿主的业务概念，不该出现在 electron-deck 的公开类型里。

  字段语义没变：它是调用方自己定义的会话标识，用来区分同一个 webContents 上先后住进来的不同会话——`wc.id` 相同但占用者换了，光靠 `connectionId` 分不出来。

  **破坏性**：给 `debugTap.record()` 传 `appSessionId` 的调用方要改成 `sessionId`。TypeScript 的多余属性检查会直接报错，不会静默失效。

  同时把 `src/main/debug-tap.ts` 注释里的下游专有名（`bridge-router`、`SERVICE_INVOKE`、`API_RESPONSE`）换成了中性描述，`docs/foundation.md` 的举例也一并中性化——文档结构和技术内容不变，只换例子里的模块名。

- 28c892c: placement 的默认发布时机从「下一个动画帧」改成「当前渲染步之后的下一个宏任务」

  渲染进程测量到槽位矩形变化后，要把新的 placement 发给主进程。之前这一步排在 `requestAnimationFrame` 里等下一帧，实测平均多等约 17ms；现在用 MessageChannel 投一个宏任务，实测约 1ms。拖动分屏把手或拖拽面板时，原生视图跟手的延迟主要就来自这一段。

  这条只改默认值。`createDeckLayoutClient` / `createPlacementPublisher` 注入了 `schedulePublish` 的调用方不受影响，仍然按注入的调度器走。

  **下游可能观察到的变化**：placement 现在可能在同一帧内就到达主进程，而不是必然落到下一帧。如果你的代码依赖「发布一定发生在下一次绘制之前/之后」这个隐含时序（例如在同一个 tick 里先改 DOM 再读主进程侧的状态），需要重新确认。发布频率没有变——驱动测量的仍然是 view-anchor 自己的 rAF 跟随循环和 ResizeObserver，窗口隐藏时一起被浏览器节流。

- 0666b26: 收缩公开的 `@experimental` 表面：删掉声明式装配子系统和几个从未有下游用过的便捷入口

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

- 0666b26: 依赖升级到 view-anchor `1.0.0-beta.2`。

  v1 把原来的两种锚合并成一个 `createViewAnchor`，选项 `guardDisplayNone` 改名为
  `treatZeroAreaAsHidden`。beta.2 不再替调用方监听分隔条；`createDeckLayoutClient`
  会在按下分隔条和拖动期间调用锚的 `pulse()`，让只改变位置的原生视图继续跟随。

  **破坏性**：仅影响注入 `createAnchor` 的调用方。工厂接收
  `treatZeroAreaAsHidden`（不再是 `guardDisplayNone`），返回的锚除 `dispose()` 外还须实现
  `pulse()`；不注入时使用默认锚，无需修改调用代码。

  `./client` 与 `./client/browser` 的体积基线更新为 3266 字节（gzip）。仅升级 beta.2
  时实测为 3014 字节；增加分隔条逐次 `pulse()` 的跟随代码后为 3266 字节。体积门禁仍限制后续增长不超过基线的 5%。

### Patch Changes

- 0666b26: `electron` peer 依赖从 `^43.2.0` 放宽到 `>=30.5.1`

  框架用到的 Electron API（`WebContentsView`、`View.addChildView/removeChildView/children`、`BaseWindow.contentView`、`senderFrame`）从 Electron 30 起都有，原来的范围把 30–42 的应用挡在外面。30.5.1 是实测通过的最低版本：真实 Electron e2e 全部通过，重复 `addChildView` 把视图移到最上层的行为也与合框的假设一致。CI 现在同时在这个最低版本上跑 e2e。

  不是破坏性变更：原来能装的版本现在依然能装。

- 0666b26: 包描述和 keywords 改用 host shell 口径

  `description` 原来只说「dockable panels」，把这个包描述成一个停靠布局库。实际上 dock 只是它的一个面：多窗口编排、原生 `WebContentsView` 跟住 DOM、浮层与 popout、跨进程 IPC 才是主体；`/layout` 和 `/dock-react` 是另一个正交的、不依赖 Electron 的面，纯浏览器项目能单独用。

  npm 页面和搜索结果直接读这两个字段，所以它们决定了别人第一眼以为这个包是干什么的。两个 README 的摘要行和 banner 文案也已经对齐同一套说法。

  keywords 补上 `host-shell`、`framework`、`multi-window`、`ipc`。
