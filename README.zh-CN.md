<p align="center">
  <img src="https://raw.githubusercontent.com/lbb00/electron-deck/main/assets/banner.svg" alt="electron-deck —— 原生视图永远盖在 DOM 之上，这摞层序由主进程规划" width="820">
</p>

> 在 Electron 上搭 host shell 的框架：多窗口编排、原生 WebContentsView 跟住 DOM、浮层与 popout、跨进程 IPC，都收在一个 `electronDeck(config)` 入口后面。另带一个不依赖 Electron 的 dock 布局引擎。

[![npm version](https://img.shields.io/npm/v/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![npm downloads](https://img.shields.io/npm/dm/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![License](https://img.shields.io/npm/l/electron-deck)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

用一组正交原语在 Electron 上拼出 host shell：多窗口管理、原生 `WebContentsView` 的叠放与几何跟随、浮层与 popout、跨进程 IPC。宿主写一份注入式 `RuntimeBackend`，框架负责 Electron 装配、transport 接线和信任边界。

## 特性

- **单入口** —— `electronDeck(config)` 收一份 `RuntimeBackend`，接管应用装配：`whenReady()` gating、transport 接线、信任边界。
- **跟住 DOM 的原生视图** —— WebContentsView 跨进程边界跟踪 DOM 元素几何，构建在 [view-anchor](https://github.com/lbb00/view-anchor) 之上。
- **可停靠布局** —— 纯 TypeScript 的 layout-as-data 引擎（`/layout`）和它的 React 渲染器 `<DockView>`（`/dock-react`），纯浏览器项目同样可用。
- **子路径浏览器纯净** —— `/layout` 与 `/dock-react`（含传递依赖）绝不 import `electron` 或 `node`；两条边界各有测试钉死。
- **子路径导出** —— `main` / `preload` / `host` / `client` / `layout` / `dock-react` 各自独立入口。
- **渐进式 API** —— `electronDeck()` 是稳定的集成路径，另有一套明确标注 `@experimental` 的声明式装配面。

**dock 布局和 host shell 是两个正交的面。** `/layout` 与 `/dock-react` 不 import electron，纯浏览器项目能单独用；反过来，上面那些 host-shell 原语也不依赖它们。宿主可以只取其一，两个一起用也行。

## 性能

这里的每条结论都有一条可复现的命令：

- **原生视图与 DOM 的偏差约 1 ms** —— placement publisher 把同一渲染步骤内的多次 `set`/`remove` 合并成一次 IPC 发布，调度在渲染步骤之后的任务里，而不是下一动画帧。`DECK_DEMO_LAG=1 pnpm run examples:dockable` 用真实指针拖拽分割条，并报告原生视图落后 DOM 槽位的时间（本机 152 个样本，中位 0.9 ms，p95 2.2 ms；把同一次拖拽改回 `requestAnimationFrame` 调度，中位变成 16.9 ms，落后整整一帧）。
- **产物体积有 ratchet 门禁** —— `pnpm run check:bundle-size` 用 esbuild 为每个公开入口打一个消费者包；入口没有经过审阅的 baseline，或 gzip 体积比 `scripts/bundle-size.baseline.json` 增长超过 5%，都会失败。`pnpm run check:tree-shaking` 验证只从 `electron-deck/layout` 导入 `createInitialState` 时，布局入口里的其他代码会被摇掉，产物约 100 B gzip，而不是整个 5 KB 的入口；根入口的用例另行检查 `dock-react` 没有进入根入口的依赖图。两者都在 `prepack` 里运行。
- **窗口清理有内存回归测试** —— `pnpm exec vitest run src/internal/deck-app.memory-regression.test.ts` 在模拟 Electron 环境中循环开关窗口和视图，强制 GC 后检查已关闭对象可回收，且堆增长小于 1 MB。它验证的是 `DeckApp` 的对象持有，不代表真实 Electron 的原生内存。
- **主进程每帧路径很便宜** —— `pnpm bench` 测量每帧的 `authorizeSnapshot → reconcile → applyReconciledPlacements`；十来个视图时预期每帧几微秒，单次运行有噪声。

## 安装

```bash
pnpm add electron-deck
# 或
npm install electron-deck
```

`electron`（`>=30.5.1`，`WebContentsView` 从 30 开始才有；CI 会分别在这个最低版本和 `devDependencies` 里的版本上跑 e2e）是可选 peer 依赖——只用 `/layout` 和 `/dock-react` 的纯浏览器项目不需要它。`/dock-react` 需要 React ≥ 18。

## 快速上手

### 接管整个应用的装配

实现一份 `RuntimeBackend`（在 `assemble(runtime)` 里建窗口、接自己的 IPC），交给 `electronDeck()`：

```ts
// main.ts
import { electronDeck } from 'electron-deck'
import type { RuntimeBackend } from 'electron-deck'

const myBackend: RuntimeBackend = {
	ownsWindows: false, // 主窗口交给框架建
	async assemble(runtime) {
		await runtime.mainWindow.loadFile('index.html')
	},
}

electronDeck({ backend: myBackend }).catch((err) => {
	console.error(err)
	process.exit(1)
})
```

框架负责等 `app.whenReady()`、接线 transport、划信任边界；你只负责领域内的装配（真实 context、主窗口内容、各种 view、IPC 模块）。设 `ownsWindows: true` 表示主窗口完全由 backend 自己建。

> **别在 main 模块顶层 `await electronDeck()`**。Electron 要等 main 模块求值完成才触发 `whenReady`，顶层 await 会死锁。用 `.catch(...)` 收尾。`startElectronDeck()` 的调用本身是同步返回句柄的，不会阻塞模块求值——但在顶层 `await handle.ready` 会和 `await electronDeck()` 一样死锁；这个 await 要放进事件处理器或其他 ready 之后才跑的代码里。

### 只要窗口内的 docking 布局

`electron-deck/layout` 是纯 TypeScript 的 layout-as-data 引擎，`electron-deck/dock-react` 是配套的 `<DockView>` React 渲染器。这两个子路径不碰 Node 和 Electron，纯浏览器的 web 项目直接用：

```tsx
import React from 'react'
import { createLayoutModel, createPanelRegistry } from 'electron-deck/layout'
import { DockView } from 'electron-deck/dock-react'

const registry = createPanelRegistry()
registry.register({ kind: 'dom', id: 'doc', title: '文档' })
registry.register({ kind: 'dom', id: 'output', title: '输出' })

const model = createLayoutModel({
	initialTree: {
		version: 1,
		root: {
			kind: 'split',
			id: 'root',
			orientation: 'row',
			sizes: [0.7, 0.3],
			children: [
				{ kind: 'tabs', id: 'g-main', panels: ['doc'], active: 'doc' },
				{ kind: 'tabs', id: 'g-bottom', panels: ['output'], active: 'output' },
			],
		},
	},
})

export function App() {
	return (
		<div style={{ width: '100vw', height: '100vh' }}>
			<DockView
				model={model}
				registry={registry}
				renderDomPanel={(panelId) => <div>面板内容: {panelId}</div>}
				bindNativeSlot={() => {}}
			/>
		</div>
	)
}
```

- 布局是一棵可序列化的 `SplitNode` / `TabGroupNode` 树；`movePanel` / `splitPanel` / `closePanel` / `insertPanel` / `setActive` / `setSizes` / `setConstraint` 是它的 mutation，`serializeLayout` / `parseLayout` / `collectTreeProblems` 负责持久化与校验，`createLayoutModel` 是单写者的可观察模型。
- split 子节点可带 `SizeConstraint`：`fixedPx` 锁死到 N px；`minPx` 按像素定下限（不参与弹性权重分配），但用户仍可拖宽。
- panel descriptor 可带 `PanelCapabilities`（`draggable` / `acceptsDrops` / `dropPolicy` / `closable` / `hideTab`），`<DockView>` 据此约束拖拽和关闭；`computeReorderIndex` 是配套的纯几何函数。

可运行的例子在 [examples/layout-demo](./examples/layout-demo) 和 [examples/dockable-demo](./examples/dockable-demo)。

## 原生视图怎么跟住 DOM

原生 `WebContentsView` 不在 DOM 树里，它直接盖在窗口上。所以拖分割条的时候，DOM 已经到位了，原生视图还停在上一帧——那道错位是肉眼能看见的。它也盖得住 DOM 的下拉菜单。

electron-deck 的做法分三步：

1. 渲染端在要放原生视图的位置渲染一个占位节点，比如 `<div data-deck-native-slot="preview">`。
2. 客户端的 placement publisher 盯着这些槽位的几何变化，把同一个渲染步骤里的 `set` 和 `remove` 合成一次 IPC 发出去，调度在这次渲染之后的任务里，而不是等下一个 `requestAnimationFrame`——等下一帧就会落后整整一帧。
3. 主进程拿到坐标直接更新原生 `WebContentsView` 的 bounds。

实测中位延迟 0.9 ms，见上面「性能」一节的复现命令。

## 入口一览

| 你要的 | 从哪导入 |
|---|---|
| `electronDeck` 入口、`DeckConfig` / `RuntimeBackend` 等类型 | `electron-deck` |
| 主进程装配工具 | `electron-deck/main` |
| host 侧 control-bus / capability / trust 原语 | `electron-deck/host` |
| preload bridge `exposeDeckBridge()` | `electron-deck/preload` |
| renderer client `createDeckClient<HS, EV>()` | `electron-deck/client`（`/client/browser` 是别名） |
| layout-as-data 引擎 + panel registry | `electron-deck/layout` |
| `<DockView>` + `computeReorderIndex` | `electron-deck/dock-react` |

## 实验性：声明式装配面

`startElectronDeck()` 提供一套更高级的声明式配置（`hostServices` / `events`）和高层 runtime API（`runtime.windows` / `runtime.view` / `runtime.scopes`）：

```ts
import { startElectronDeck, defineEvent } from 'electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

startElectronDeck({
	app: { name: 'My Host' },
	hostServices: { getUser: async () => ({ user: null }) },
	events: [authChanged],
})
```

目前除本仓库的 examples 外没有生产消费者，请当作 `@experimental`：签名可能变化，也没经过非 demo 工作负载验证。它相对 `electronDeck()` 唯一确定的好处是调用本身同步返回，不会阻塞模块求值——但 `await handle.ready` 仍然要等到顶层求值结束之后才能进行，这点和 `electronDeck()` 一样。

## 文档

- [架构总览](./docs/architecture.md) —— 四个布局 / 多窗口原语、注入式 `RuntimeBackend`、信任边界、生命周期
- [连接层](./docs/foundation.md) —— `Connection`、资源归属、`debugTap`
- [横切契约](./docs/contracts/) —— capability 授权与 grants、统一生命周期、view handle、view-anchor 跟随

## 贡献

欢迎提 issue 和 PR。提交前请在本地依次运行 `pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm build`；构建完成后运行 `pnpm check:bundle-size`、`pnpm check:tree-shaking` 和 `pnpm check:e2e`。Electron 交互检查需要图形会话；无界面的 Linux 环境可运行 `xvfb-run --auto-servernum pnpm check:e2e`。

## License

[MIT](./LICENSE) © lbb00
