---
'electron-deck': minor
---

修复：面板换位之后原生视图卡在旧位置不动

现象：把面板拖到另一个位置（或另一个窗口）松手后，原生视图有时停在松手前的矩形上不再跟随；如果卡住的是一帧「隐藏」，该消失的视图会一直显示。之后怎么调窗口大小都不恢复，要等槽位矩形再次变化、页面导航或关窗才好。

原因：主进程收到一帧 placement 时，先把「视图现在在哪」记进账本，再下发给视图。但视图在 `moveTo` 迁移途中会拒收这一帧，原生 attach 失败时也会抛错——两种情况下这一帧都没生效，账本却已经记成生效了。而 reconcile 是电平触发的，只在「想要的」和「记录的」不一致时才产出操作；账本记错之后，后面每一帧内容相同就都是零操作，这一帧永远补不回来。

改法：下发之后再提交账本，被拒收或抛错的视图把账本回滚成上一帧的值。同一帧下次再来就会重新判定为有差异并重试。

**破坏性，在 `electron-deck/layout` 的公开导出面上**：

- `applyReconciledPlacements` 的 sink 类型从 `(p: Placement) => void` 改成 `(p: Placement) => boolean`，返回这一帧是否被接受；抛错等价于返回 `false`。
- `applyReconciledPlacements` 本身的返回值从 `void` 改成 `Set<string>`，内容是本轮被拒收的 viewId。调用方要据此回滚自己的 `state.actual`，否则同样会留下记错的账本。
- `electron-deck/main` 导出的 `ViewHandle.applyPlacement` 返回值同样是 `boolean`。自己实现 `ViewHandle` 的调用方（测试替身、适配层）需要补上返回值；只调用不实现的不受影响。

根入口的 `DeckViewHandle.applyPlacement` 签名没变，仍然返回 handle 本身用于链式调用。
