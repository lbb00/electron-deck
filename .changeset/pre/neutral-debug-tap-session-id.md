---
'electron-deck': minor
---

Rename `DebugTapEntry.appSessionId` to `sessionId` in debugTap

`appSession` was a downstream host's business concept and should not appear in electron-deck's public types.

The field's meaning is unchanged: it is a caller-defined session identifier that distinguishes successive sessions occupying the same webContents. When `wc.id` stays the same but the occupant changes, `connectionId` alone cannot distinguish them.

**Breaking change**: callers passing `appSessionId` to `debugTap.record()` must use `sessionId`. TypeScript's excess-property checks reject the old field rather than silently ignoring it.

Also replace downstream-specific names (`bridge-router`, `SERVICE_INVOKE`, and `API_RESPONSE`) in the comments of `src/main/debug-tap.ts` with neutral descriptions, and use neutral module names in the examples in `docs/foundation.md`. The documentation structure and technical content are unchanged.
