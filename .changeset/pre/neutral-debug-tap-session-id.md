---
"electron-deck": minor
---

debugTap：`DebugTapEntry.appSessionId` 改名为 `sessionId`

这个字段原来叫 `appSessionId`，其中 `appSession` 是某个下游宿主的业务概念，不该出现在 electron-deck 的公开类型里。

字段语义没变：它是调用方自己定义的会话标识，用来区分同一个 webContents 上先后住进来的不同会话——`wc.id` 相同但占用者换了，光靠 `connectionId` 分不出来。

**破坏性**：给 `debugTap.record()` 传 `appSessionId` 的调用方要改成 `sessionId`。TypeScript 的多余属性检查会直接报错，不会静默失效。

同时把 `src/main/debug-tap.ts` 注释里的下游专有名（`bridge-router`、`SERVICE_INVOKE`、`API_RESPONSE`）换成了中性描述，`docs/foundation.md` 的举例也一并中性化——文档结构和技术内容不变，只换例子里的模块名。
