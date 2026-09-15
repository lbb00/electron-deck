# Changesets

这个目录放的是「还没发布的改动说明」。每个 `.md` 文件描述一次改动：动了什么、算 patch 还是 minor / major。

## 要改的东西会影响使用者时

在 PR 里跑一次：

```bash
pnpm changeset
```

按提示选版本级别、写一句人话说明，它会生成一个 `.changeset/xxx.md`，跟代码一起提交。只改内部实现、测试或文档，使用者感知不到的，不用加。

## 合并之后会发生什么

1. 带 changeset 的 PR 合进 main 后，`changesets/action` 会自动开一个叫 **Version Packages** 的 PR：它把 `package.json` 的版本号抬上去、把这些说明汇总进 `CHANGELOG.md`、删掉已经消化的 `.changeset/*.md`。
2. 合并那个 PR，发布流程才真正跑：构建、跑完整测试、发到 npm（带 provenance 签名）、打 tag、建 GitHub Release。

也就是说发布需要合两次 PR，中间那次是给人看一眼版本号和更新日志对不对的。

发布用的是 npm trusted publishing（OIDC），仓库里没有长期有效的 npm token。具体发布逻辑在 `scripts/release.js`，工作流在 `.github/workflows/release.yml`。
