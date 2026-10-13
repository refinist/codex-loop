# codex-loop

在 Codex 中重复执行任务：检查部署进度、跟进 CI、处理 PR 反馈，或继续当前会话中未完成的工作。可以指定固定间隔，也可以让 Codex 根据每轮结果决定下一次检查时间。

## 安装

```bash
npx skills add refinist/codex-loop --skill codex-loop -g
```

需要 **Node.js ≥24.0.0**，推荐最新的 **24.x LTS**，支持 **macOS、Linux 和 Windows**。安装后，在 Codex 中通过 `$codex-loop` 调用。

脚本直接使用当前 PATH 中的 `node`，也会跟随 fnm / nvm 当前启用的版本。运行时只使用 Node.js 内置模块，无需在 skill 目录执行 `npm install`，Windows 也不需要额外的时区包。可以先检查版本：

```bash
node --version
```

低于 24 时，启动会提示升级。切换版本后，如果 Codex 仍读取旧环境，请重启 Codex。最低版本是本项目的支持基线，不表示调度算法只能在 24 上实现；版本状态见 [Node.js 官方发布说明](https://nodejs.org/en/about/previous-releases)。

## yetone 的 loop 工作流

[查看 yetone 的原推文](https://x.com/yetone/status/2109855710444237018)

### 原图

以下为 yetone 的推文截图及三张 loop 工作流原图。

![yetone 的推文截图](assets/yetone-tweet.png)

![Loop 1：GitHub issues、PR 与 Discord 用户反馈](assets/yetone-loop-github-discord.png)

![Loop 2：推特上的用户反馈](assets/yetone-loop-feedback.png)

![Loop 3：代码维护与经验总结](assets/yetone-loop-maintenance.png)

## 使用方式

时间间隔和任务内容都可以省略，不同输入对应不同的运行方式：

| 输入 | 示例 | 行为 |
|---|---|---|
| 间隔 + 任务 | `$codex-loop 5m 检查部署进度` | 立即执行一次，之后按固定时间表检查 |
| 只有任务 | `$codex-loop 检查部署进度` | 立即执行一次，每轮结束后决定下次等待时间 |
| 只有间隔 | `$codex-loop 15m` | 按固定时间表执行默认任务 |
| 不带参数 | `$codex-loop` | 以动态间隔执行默认任务 |

### 让 Codex 决定间隔

不指定时间时，Codex 会根据本轮观察，在 **1 分钟到 1 小时**之间选择下一次等待时间，并说明原因。结果即将出现时缩短等待，没有新变化时延长等待。

```text
$codex-loop 检查 CI 是否通过，并处理新的代码评审意见。
```

动态循环会在目标完成、用户取消，或判断继续执行已无帮助时结束。没有固定的默认五分钟间隔。

### 按固定间隔执行

把间隔放在任务前面，或在末尾使用 `every N units`：

```text
$codex-loop 5m 检查部署是否完成，并告诉我结果。
```

```text
$codex-loop 检查部署是否完成，并告诉我结果 every 2 hours
```

支持 `s`（秒）、`m`（分钟）、`h`（小时）和 `d`（天）。固定调度精度为一分钟，秒数向上取整；不能均匀映射到 cron 的间隔会调整并告知，例如 `7m → 6m`、`90m → 2h`。

固定间隔按时间表触发，不是每轮完成后重新等待完整间隔。上一轮尚未结束时不会并发执行，错过多个周期也只补执行一次。实际触发还可能有调度偏移，详见[调度规则](references/behavior.md)。

### 执行默认任务

不提供任务内容时，Codex 会按顺序继续会话中已授权但尚未完成的工作、处理当前分支 PR 的反馈与 CI 问题，再进行范围内的代码检查或简化。

```text
$codex-loop
```

只指定间隔时，也使用默认任务：

```text
$codex-loop 15m
```

### 用 loop.md 自定义默认任务

也可以创建 `loop.md` 自定义默认任务。每轮会重新读取文件，修改后下一轮生效：

| 文件 | 作用范围 |
|---|---|
| `.codex/loop.md` | 当前项目，优先使用 |
| `$CODEX_HOME/loop.md`，默认 `~/.codex/loop.md` | 没有项目配置时使用 |

文件使用普通 Markdown，直接写要重复执行的任务即可。显式提供任务时忽略默认文件；文件内容最多读取 25,000 字节。

例如，在项目中创建 `.codex/loop.md`，写入下面的内容，并将 `release/next` 换成你的实际分支：

```markdown
# 发布分支维护

关注当前仓库 release/next 分支的 PR：

- CI 失败时，检查失败日志，修复原因并运行相关测试。
- 出现新的评审意见时，逐条核对并处理，说明修改和验证结果。
- 只有在本次任务已授权时，才推送改动、回复评论或解决评审讨论。
- 没有新变化时简短说明；需要额外权限或人工决定时，说明阻碍并停止。

每轮结束后判断是否还需要继续，并说明下次检查时间及原因。
```

然后在该项目的 Codex 聊天中启动：

```text
$codex-loop
```

这份文件是一条默认任务，不是多个定时任务的配置清单。若改用 `$codex-loop 15m`，任务内容相同，但触发时间由固定时间表决定，文件中的时间建议不会覆盖它。

### 查看与停止

在聊天中说“列出当前 loop”查看任务，或说“停止这个 loop”取消。固定循环会持续到取消、达到明确的结束条件或七天过期；动态循环每轮决定是否继续。

默认在当前聊天的活跃轮次中执行和等待。停止生成或退出后不会自动唤醒；动态循环需要重新开启，固定任务可在明确请求恢复后继续。

如果希望在独立终端中运行，使用附带的 [CLI driver](references/cli.md)。它在前台持有独立的 Codex worker，并在等待结束后恢复该会话；不继承当前聊天的历史。

### 运行说明

- **会话需要保持运行**：聊天模式在当前活跃轮次中等待，不是后台服务。
- **独立终端运行**：CLI 默认只读；需要修改项目时使用 `--sandbox workspace-write`。可用 `--max-runs` 限制执行轮数，`--timeout` 限制单轮时间。
- **遇到错误暂停**：执行失败、超时或返回无效决策时，任务会停止等待处理，不会自动反复重试。
- **状态可以查询**：记录任务 ID、执行次数、下次时间和决策理由，方便检查运行情况。

更多配置见 [CLI 用法](references/cli.md)和[调度规则](references/behavior.md)。
