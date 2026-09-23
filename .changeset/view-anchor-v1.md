---
'electron-deck': minor
---

依赖升级到 view-anchor `1.0.0-beta.2`。

v1 把原来的两种锚合并成一个 `createViewAnchor`，选项 `guardDisplayNone` 改名为
`treatZeroAreaAsHidden`。beta.2 不再替调用方监听分隔条；`createDeckLayoutClient`
会在按下分隔条和拖动期间调用锚的 `pulse()`，让只改变位置的原生视图继续跟随。

**破坏性**：仅影响注入 `createAnchor` 的调用方。工厂接收
`treatZeroAreaAsHidden`（不再是 `guardDisplayNone`），返回的锚除 `dispose()` 外还须实现
`pulse()`；不注入时使用默认锚，无需修改调用代码。

`./client` 与 `./client/browser` 的体积基线更新为 3266 字节（gzip）。仅升级 beta.2
时实测为 3014 字节；增加分隔条逐次 `pulse()` 的跟随代码后为 3266 字节。体积门禁仍限制后续增长不超过基线的 5%。
