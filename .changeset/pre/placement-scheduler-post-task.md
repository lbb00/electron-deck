---
'electron-deck': minor
---

placement 的默认发布时机从「下一个动画帧」改成「当前渲染步之后的下一个宏任务」

渲染进程测量到槽位矩形变化后，要把新的 placement 发给主进程。之前这一步排在 `requestAnimationFrame` 里等下一帧，实测平均多等约 17ms；现在用 MessageChannel 投一个宏任务，实测约 1ms。拖动分屏把手或拖拽面板时，原生视图跟手的延迟主要就来自这一段。

这条只改默认值。`createDeckLayoutClient` / `createPlacementPublisher` 注入了 `schedulePublish` 的调用方不受影响，仍然按注入的调度器走。

**下游可能观察到的变化**：placement 现在可能在同一帧内就到达主进程，而不是必然落到下一帧。如果你的代码依赖「发布一定发生在下一次绘制之前/之后」这个隐含时序（例如在同一个 tick 里先改 DOM 再读主进程侧的状态），需要重新确认。发布频率没有变——驱动测量的仍然是 view-anchor 自己的 rAF 跟随循环和 ResizeObserver，窗口隐藏时一起被浏览器节流。
