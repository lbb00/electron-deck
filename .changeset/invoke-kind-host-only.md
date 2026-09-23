---
"electron-deck": minor
---

去掉 `simulator` 概念：wire 只保留 `host` 调用类型，`DeckConfig.simulatorApis` 一并删除

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
