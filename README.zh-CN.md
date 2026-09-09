# electron-deck

> Electron 的窗口与视图编排：可停靠面板、原生 WebContentsView 跟随 DOM 几何，全部收敛到一个 `electronDeck(config)` 入口。

[![npm version](https://img.shields.io/npm/v/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![npm downloads](https://img.shields.io/npm/dm/electron-deck)](https://www.npmjs.com/package/electron-deck)
[![License](https://img.shields.io/npm/l/electron-deck)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

用一组正交原语在 Electron 上拼出 host-shell：多窗口管理、原生 `WebContentsView` 的叠放与几何跟随、浮层与 popout、跨进程 IPC。宿主写一份注入式 `RuntimeBackend`，框架负责 Electron 装配、transport 接线与信任边界。

## 特性

- **单入口** —— `electronDeck(config)` 收一份 `RuntimeBackend`，接管应用装配：`whenReady()` gating、transport 接线、信任边界。
- **跟随 DOM 的原生视图** —— WebContentsView 跨进程边界跟踪 DOM 元素几何，构建在 [view-anchor](https://github.com/lbb00/view-anchor) 之上。
- **可停靠布局** —— 纯 TypeScript 的 layout-as-data 引擎（`/layout`）和它的 React 渲染器 `<DockView>`（`/dock-react`），纯浏览器项目同样可用。
- **子路径浏览器纯净** —— `/layout` 与 `/dock-react`（含传递依赖）绝不 import `electron` 或 `node`；两条边界各有测试钉死。
- **子路径导出** —— `main` / `preload` / `host` / `client` / `layout` / `dock-react` 各自独立入口。
- **渐进式 API** —— `electronDeck()` 是稳定的集成路径，另有一套明确标注 `@experimental` 的声明式装配面。

## 安装

```bash
pnpm add electron-deck
# 或
npm install electron-deck
```

`electron`（`^43.2.0`）是可选 peer 依赖——只用 `/layout` 和 `/dock-react` 的纯浏览器项目不需要它。`/dock-react` 需要 React ≥ 18。

## 快速上手

### 接管整个应用的装配

实现一份 `RuntimeBackend`（在 `assemble(runtime)` 里建窗口、接自己的 IPC），交给 `electronDeck()`：

```ts
// main.ts
import { electronDeck } from 'electron-deck'
import { myBackend } from './my-backend.js'

electronDeck({ backend: myBackend }).catch((err) => {
  console.error(err)
  process.exit(1)
})
```

框架负责等 `app.whenReady()`、接线 transport、划信任边界；你只负责领域内的装配（真实 context、主窗口内容、各种 view、IPC 模块）。设 `ownsWindows: true` 表示主窗口完全由 backend 自己建。

> **别在 main 模块顶层 `await electronDeck()`**。Electron 要等 main 模块求值完成才触发 `whenReady`，顶层 await 会死锁。用 `.catch(...)` 收尾，或改用 `startElectronDeck()`（它内部已对 `whenReady` 做了 gating）。

### 只要窗口内的 docking 布局

`electron-deck/layout` 是纯 TypeScript 的 layout-as-data 引擎，`electron-deck/dock-react` 是配套的 `<DockView>` React 渲染器。纯浏览器的 web 项目也直接用这两个子路径。

- 布局是一棵可序列化的 `SplitNode` / `TabGroupNode` 树；`movePanel` / `splitPanel` / `closePanel` / `insertPanel` / `setActive` / `setSizes` / `setConstraint` 是它的 mutation，`serializeLayout` / `parseLayout` / `validateTree` 负责持久化与校验，`createLayoutModel` 是单写者的可观察模型。
- split 子节点可带 `SizeConstraint`：`fixedPx` 锁死到 N px；`minPx` 按像素定下限（不参与弹性权重分配），但用户仍可拖宽。
- panel descriptor 可带 `PanelCapabilities`（`draggable` / `dropPolicy` / `closable` / `hideTab`），`<DockView>` 据此约束拖拽和关闭；`computeReorderIndex` 是配套的纯几何函数。

可运行的例子在 [examples/layout-demo](./examples/layout-demo) 和 [examples/dockable-demo](./examples/dockable-demo)。

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

`startElectronDeck()` 提供一套更高级的声明式配置（`hostServices` / `events` / `toolbar`）和高层 runtime API（`runtime.windows` / `runtime.view` / `runtime.scopes` / `runtime.grants`）：

```ts
import { startElectronDeck, defineEvent } from 'electron-deck'

const authChanged = defineEvent<{ user: { id: string } | null }>('authChanged')

startElectronDeck({
  app: { name: 'My Host' },
  hostServices: { getUser: async () => ({ user: null }) },
  events: [authChanged],
})
```

目前除本仓库的 examples 外没有生产消费者，请当作 `@experimental`：签名可能变化，也没经过非 demo 工作负载验证。它相对 `electronDeck()` 唯一确定的好处是内部已对 `whenReady()` 做了 gating，可以在 main 模块顶层直接调用。

## 文档

- [架构总览](./docs/architecture.md) —— 四个布局 / 多窗口原语、注入式 `RuntimeBackend`、信任边界、生命周期
- [连接层](./docs/foundation.md) —— `Connection`、资源归属、`debugTap`
- [横切契约](./docs/contracts/) —— capability 授权与 grants、统一生命周期、view handle、view-anchor 跟随

## 贡献

欢迎提 issue 和 PR。提交前请在本地跑一遍：`pnpm lint`、`pnpm check-types`、`pnpm test`、`pnpm build`。

## License

[MIT](./LICENSE) © lbb00
