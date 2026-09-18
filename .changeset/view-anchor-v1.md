---
'electron-deck': minor
---

依赖升级到 view-anchor `1.0.0-beta.1`

v1 把原来的两种锚合并成一个 `createViewAnchor`，选项 `guardDisplayNone` 改名为
`treatZeroAreaAsHidden`。`createDeckLayoutClient` 默认用的就是这个新锚，行为不变。

**破坏性**：只影响自己注入 `deps.createAnchor` 的调用方——注入的工厂现在收到的是
`treatZeroAreaAsHidden`，不再是 `guardDisplayNone`。不注入就不受影响。

```diff
 createDeckLayoutClient({
   bridge,
   deps: {
-    createAnchor: (target, { guardDisplayNone }) => myAnchor(target, { guardDisplayNone }),
+    createAnchor: (target, { treatZeroAreaAsHidden }) => myAnchor(target, { treatZeroAreaAsHidden }),
   },
 })
```

`./client` 与 `./client/browser` 的体积基线从 2798 提到 3040 字节（gzip）：v1 把两种
锚合并成一份实现后，单独打包的锚从 1368 涨到 1523 字节（gzip），其余是打包上下文差异。
