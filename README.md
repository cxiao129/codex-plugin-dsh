# codex-plugin-dsh

中文 | [English](https://github.com/wingoo/codex-plugin-dsh/blob/main/README.en.md)

![Codex App Server 与 DeepSeek Harness 的本地 provider 架构](docs/assets/codex-dsh-hero.png)

在 DeepSeek Harness 里直接使用你本机已经登录的 Codex，无需在 DSH 中配置 OpenAI API Key。安装并重启后，现有模型选择器中会出现 **Codex App Server (local)**，选择模型即可开始对话。

会话和工具调用仍由 DSH 管理，现有 DSH 插件与工具可以照常使用；模型请求通过本地 Codex App Server 连接当前 Codex 账户。插件也支持图片输入，并能把 Codex 原生图片生成结果直接回写到 DSH 对话。

## 快速安装：直接让 DSH 完成

如果当前 DSH 会话具有完整的宿主机权限，把下面这段话直接发给它：

```text
请将 github:wingoo/codex-plugin-dsh 安装到当前 DSH 的 web profile，不要修改 DeepSeek Harness 源码。

1. 检查本机是否已经安装符合插件要求的 Codex CLI；如果尚未安装或版本过旧，请先按照 OpenAI 官方方式安装或升级。
2. 运行 codex login status 检查登录状态。如果尚未登录，请让我在运行 DSH 的主机终端执行 codex login；等我完成浏览器登录并回复“已登录”后再继续。
3. 确认 codex app-server --help 可以正常运行。
4. 安装插件，并通过 dsh --profile web --dump-config 确认 codex-app-server-provider 已加载。
5. 沿用当前 DSH Web 服务原来的启动方式完成重启，不要在同一端口启动第二个实例。重启前提醒我连接会暂时中断。
6. 服务恢复后提醒我刷新页面，并在现有模型选择器中选择 Codex App Server (local)。

如果无法可靠判断原来的启动方式，不要猜测或结束无关进程，直接告诉我应该执行的重启命令。
```

这会修改 DSH profile 并在宿主机上运行插件代码，请先确认仓库来源。重启期间当前连接会暂时中断，服务恢复后刷新页面即可。

## 通过命令行安装

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

如果从 DeepSeek Harness 源码仓库运行：

```sh
pnpm dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

正式版本发布前，可以锁定已验证的 commit，让安装结果保持一致：

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh#<commit-sha>
```

## 安装本地 checkout

```sh
dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

从 DeepSeek Harness 源码仓库运行时：

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

## 安装后使用

沿用原来的启动方式重启 DSH Web 服务，不要在同一端口启动第二个实例。服务恢复后刷新浏览器，在输入框下方打开现有模型选择器，然后从 **Codex App Server (local)** 分组中选择模型。

空白工作区会话最初使用当前默认模型；发送第一条消息前也可以先切换到 Codex。

## 更新已安装插件：直接让 DSH 完成

已经安装过插件时不需要先卸载。把下面这段话发给具有完整宿主机权限的 DSH 会话：

```text
请把当前 DSH web profile 中已经安装的 codex-plugin-dsh 更新到 GitHub main 的最新版本，不要修改 DeepSeek Harness 源码，也不要先卸载插件。

1. 先运行 command -v dsh，确认当前环境能否直接调用 dsh。
2. 如果可以，运行 dsh plugin --profile web update codex-plugin-dsh；如果没有全局 dsh 命令且当前服务通过 npx 启动，改用 npx --yes @deepseek-ai/dsh plugin --profile web update codex-plugin-dsh。
3. 检查 ~/.dsh/profiles/web/pnpm-lock.yaml，确认 codex-plugin-dsh 的 GitHub tarball commit 已更新；同时运行 dsh --profile web --dump-config（npx 启动时使用对应的 npx 命令）确认 codex-app-server-provider 仍然存在。
4. 更新成功后，沿用当前 Web 服务原来的启动方式重启，不要在同一端口启动第二个实例。重启前提醒我连接会暂时中断。
5. 服务恢复后提醒我刷新页面，并新建一个会话测试 Codex 模型。

如果更新命令被 sandbox 拒绝，请只为这个更新操作请求所需权限；如果无法可靠判断原来的启动方式，不要猜测或结束无关进程，直接告诉我应该执行的重启命令。
```

更新会刷新 GitHub 依赖所解析的 commit，同时保留 web profile 中已有的插件 bundle 配置。

### 通过终端更新

已经安装全局 `dsh` 命令：

```sh
dsh plugin --profile web update codex-plugin-dsh
```

通过 `npx` 运行 DSH：

```sh
npx --yes @deepseek-ai/dsh plugin --profile web update codex-plugin-dsh
```

从 DeepSeek Harness 源码仓库运行：

```sh
pnpm dsh plugin --profile web update codex-plugin-dsh
```

更新完成后必须重启原有 DSH Web 服务，正在运行的进程不会自动加载磁盘上的新插件代码。

## 环境要求

- Node.js `^22.19.0` 或 `>=24`
- DeepSeek Harness `0.1.1-rc.2`（插件依赖按该宿主版本精确锁定）
- 本地 Codex CLI `>=0.148.0`
- 已通过 `codex login` 登录的 Codex 账户

### 准备 Codex CLI

本插件使用宿主机上的 Codex CLI，不会代为下载、升级或登录。按照 [OpenAI Codex CLI](https://github.com/openai/codex) 的安装方式准备本机运行时：

```sh
npm install -g @openai/codex
codex login
```

确认运行 DSH 的环境能够找到 Codex，并且 App Server 可用：

```sh
codex --version
codex app-server --help
```

Codex CLI 自己管理账户认证和产品设置；插件不读取或保存 API Key，也不要求把 OpenAI API Key 填入 DSH。

## 当前状态

当前适配基线为 macOS 上的 DeepSeek Harness `0.1.1-rc.2` 与 Codex CLI `0.148.0`。DSH `prepareCall`、provider retry policy、ReplayEnvelope、`session/disposed` 生命周期、compaction／session-title 辅助调用、上下文容量元数据、图片输入与输出，以及动态工具暂停／续跑均有回归覆盖。

Windows 批处理 shim 启动已有单元测试，但仍需在真实 Windows 主机上运行。运行时 DSH 包与开发依赖精确锁定到已验证的 `0.1.1-rc.2`，避免跨预发布接口版本混装。

## 配置

安装后会使用安全默认值自动启用。profile 可以在自己的 `cordis.patch.yml` 中覆盖已插入的插件行：

```yaml
- id: codex-app-server-provider
  config:
    executable: codex
    env: {}
    modelCacheMs: 30000
    catalogTimeoutMs: 10000
    turnTimeoutMs: 3600000
    disposeGraceMs: 3000
    stderrMaxBytes: 16384
    modelPageSize: 100
    contextWindowTokens: 0
    modelContextWindows: {}
    registryPath: ''
    ephemeralOneShotSubagents: true
    syncThreadNames: true
    subagentSectionName: DSH 子代理
```

`executable` 由 DSH 在 subprocess provider 的执行环境中解析，因此如果未来使用远程或沙箱 subprocess provider，Codex 也必须安装在同一个执行环境中。`env` 是显式子进程环境覆盖，不要把凭证写进已提交的 profile。

`turnTimeoutMs` 是 App Server 无活动时的空闲期限，默认 60 分钟，以容忍长推理和短暂网络中断；当 App Server 正在等待 DSH 动态工具结果或用户回答时，期限暂停，直到请求完成后重新计时。`contextWindowTokens` 是模型目录尚未提供容量时的全局回退值，`modelContextWindows` 可按模型 ID 覆盖；插件为 `gpt-5.6-sol` 默认声明 1,048,576 token，其余模型不猜测容量。App Server 运行后若通过 token-usage 通知报告了容量，插件会优先使用该实测值。若希望 DSH 对其他模型在首轮就能提前触发自动压缩，应显式配置可靠容量。`registryPath` 留空时使用默认 sidecar 路径；只有需要隔离多个 Host 实例时才应覆盖，并确保它们不管理同一组 thread。`ephemeralOneShotSubagents` 默认让 durable descriptor 明确标记为 one-shot 的 DSH 子 Agent 使用 ephemeral Codex thread；DSH 子 Session、工具循环和最终 settlement 仍照常持久化。`syncThreadNames` 为持久 thread 应用 `[DSH]`／`[DSH 子代理]` 前缀；`subagentSectionName` 指定 continuable 或无法安全分类的持久子 Agent 所在 App Server Section，留空可关闭分组。

## 运行行为

- DSH Agent Loop 不会固定调用某个 HTTP API。它使用当前会话选中的 provider／model 调用 DSH LLM service；选择 Codex 后，请求路由到本插件，再通过 stdio 交给本地 Codex App Server。DSH 默认模型只影响尚未显式选择模型的新会话，不是 Codex 路由的第二个上游。
- DSH 会照常完成系统提示和工具组装。插件只接收本次请求的 `options.tools`，不会再次枚举全局工具，因此 preset、scope、allow／deny 和 code mode 的结果不会被绕过或重复。
- App Server 请求 `dsh` namespace 中的动态工具时，插件先返回普通 DSH `tool-call`。DSH Agent Loop 负责权限、调度、执行和 `tool/call`／`tool/result` 日志；待答复的 App Server RPC 会暂停空闲期限，工具或用户等待即使超过默认 60 分钟期限也不会被误关。收到结果的后续 Provider 调用再把它送回同一个 App Server turn。该续跑步骤固定使用原始 App Server turn 的模型和工具目录；即使界面选择或下一步组装结果已变化，也会先安全完成这个已发出的工具调用，变更在当前 App Server 回合结束后生效。插件不会自己再执行一遍工具。会话销毁、插件卸载或请求外真正无活动超时仍会关闭进程并显式拒绝待处理 RPC。
- DSH 工具产生的图片结果会作为动态工具图片输出返回给 Codex；`additionalContexts` 会通过 `turn/steer` 进入同一个 turn，而不是被错误拼进工具结果。
- App Server thread 保留动态工具目录。若当前会话仍有等待动态工具结果的活跃 turn，后续 provider step 会优先续跑该 turn，并固定使用它原来的模型和工具目录。否则插件先 `thread/read`：仅当 replay checkpoint 正好是远端已完成的 head 时才 `thread/resume` 原 thread；远端存在失败回合、外部追加或其他 head 分歧时，才从 DSH checkpoint `thread/fork`。工具目录变化会创建新 thread，并从 DSH 持久消息重建可导入历史。
- DSH 会话的工作区会成为 App Server thread 的工作目录，但 App Server 固定使用只读 sandbox 和 `never` approval。Codex 自带 shell、文件修改、Web、MCP、Apps、Plugins、view-image 和 multi-agent 能力会被关闭或拒绝；这些动作只能走 DSH 工具生态。
- Codex 原生 imagegen 是有意保留的例外，它由 App Server 直接完成，不进入 DSH 工具循环。
- DSH 图片附件会先由 attachment service 校验，再以内联 data URL 传给 App Server；不依赖双方共享本地文件路径。
- App Server 完成的图片生成结果会保存为 DSH 图片附件，并作为 assistant 图片显示在原有对话中。能否调用图片生成工具取决于当前 Codex 账户、模型和 App Server 能力，不要求在 DSH 中另配 OpenAI API Key。
- Codex 通过官方 App Server `reasoning` item 公开的推理摘要会作为标准 DSH reasoning block 写入会话日志，因此 Source、会话导出与重放会显示相同摘要；插件不会尝试读取或保存未公开的内部 CoT。`turn/start` 会显式请求 `summary: "concise"`，以最大可能拿到推理摘要（模型/账户是否真的产出摘要仍由 App Server 决定）。
- 成功回合会把 App Server thread、turn 和工具目录签名写入 DSH 模型 replay state。DSH Session Log 是会话事实来源：若 checkpoint 指向的 App Server thread 已缺失，插件会新建自有 thread，并从 DSH 历史重建所有可表示内容，而不是丢失上下文。
- 会话从其他 DSH provider 切换到 Codex 时，已完成的文本、用户图片和工具历史会通过 App Server `thread/inject_items` 方法导入。DSH 合成的 user 上下文（例如子 Agent 结束通知）若携带 `reasoning`、`tool-call` 或嵌套 `tool-result`，会被投影为明确标注的惰性文本／图片上下文；其中的工具调用不会在父线程执行，也不会形成悬空的 App Server function call。
- App Server 进程由 DSH subprocess service 管理；启动阶段在 turn 发布前也已纳入所有权跟踪。一个进程可跨越多个 DSH 工具 step 和等待交互结果的 DSH 回合边界；所属 `session/disposed` 或插件卸载会先取消并等待尚未完成的 initialize／read／resume／fork／turn-start，再关闭已发布进程，避免销毁后晚到的 turn 泄漏。App Server 回合完成或请求外空闲超时也会按进程树终止。
- DSH Session header 的 `origin: subagent` 与 child 自有事件后缀中的首个 durable `subagent/descriptor` 共同决定 thread 展示策略；fork seed 中继承的祖先 descriptor 不参与分类。只有 descriptor 明确为 `one-shot` 的 child 才进入 ephemeral 模式；缺失或不支持的 descriptor 一律 fail closed，继续使用持久 thread。ephemeral one-shot 仍可在同一个活跃 App Server turn 内跨 DSH 动态工具 step 续跑，但不写 creation receipt，也不向终态 assistant message发布 replay state。
- 持久主 thread 优先使用最新 DSH `session/title`，否则使用首条直接人类消息，并通过 `thread/name/set` 命名为 `[DSH] …`。持久子 Agent 使用 descriptor label／人类标题命名为 `[DSH 子代理] …`，并通过 App Server Section API 移入配置的子代理分组。命名或分组是 best-effort 展示增强，失败不会阻断模型请求；DSH Session Log 与子代理拓扑仍是事实来源。
- DSH `compaction` 与 `session-title` 辅助调用使用独立的 ephemeral App Server thread，不继承或占用同会话中待工具结果的对话 turn，也不开放动态工具、交互提问或 replay state。它们可以携带 `maxTokens`；Codex App Server `0.148.0` 没有对应的 turn 字段，因此插件把该辅助上限视为提示并允许调用继续。普通对话中的 `maxTokens` 仍明确拒绝，避免用户配置被静默忽略。

## Thread registry 与治理

插件维护一个可修复的 sidecar registry（默认 `~/.dsh/codex-plugin-dsh/thread-registry.json`），记录由插件创建的 thread 所有权凭据、每个 DSH Session 的 canonical／branch 引用和引用计数。DSH Session Log 才是会话与 checkpoint 的事实来源；registry 丢失或陈旧时可通过持久 Session 历史 reconcile 重建引用，但仅从日志发现的 thread 不会被推定为插件所有。

普通对话的 start／read／resume／fork／历史重建都不会 archive、unarchive 或 delete 已有 thread。显式生命周期操作同样 fail closed：registry 快照公开所有权、本地活跃态和实时引用计数；archive 只处理未 release、有创建凭据、未共享且经 `thread/read` 确认远端没有 `inProgress` head 的 thread；unarchive 只恢复该 registry 自己归档的自有 thread；purge 还要求显式确认、Session 引用先 release、实时引用计数为零、所有权可证明，并在删除前再次读取远端活跃态。registry 存储损坏时不会覆盖原文件，状态会标记为 unhealthy；从 DSH 日志重建但没有创建凭据的既有 thread 仍保持非自有状态。

存量治理可先运行 `pnpm dry-run:archive-threads [报告路径]`。该命令只读扫描 DSH Session 日志、ownership registry 与 Codex SQLite 展示状态，输出 `eligible_after_live_check`／`already_archived`／`blocked` 的原因码清单；不调用 archive／delete，不写 Codex SQLite，也不把标题、prompt、模型输出或工作区路径写入报告。真正归档时仍必须逐项走 registry lifecycle 路径，再执行本地活跃 fence 与实时 `thread/read` 检查；dry-run 本身不是归档授权。

同一进程内，reconcile 使用 single-flight；新 thread/turn 启动与显式 lifecycle RPC 共用同一个 fence，registry receipt／Session event／reconcile／管理变更共用有序状态锁，避免检查后又出现新 turn 或新引用。每个远端 archive／unarchive／delete 在 RPC 前先持久化 write-ahead intent，成功后再提交 projection；最终写盘失败时 intent 会留在 sidecar，同一 operationId 可在重启后安全重试／续办，而不会丢失远端变更证据。Session/thread 管理操作仍按 key 串行化，避免并发重复处理。这些锁不跨 DSH 进程；不得让多个 Host 进程并发管理同一 registry 或同一组 App Server thread，跨进程协调由部署方负责。

## 交互问题桥接（requestUserInput）

本 fork 在原有基础上实现了 DSH 交互问题桥接：App Server 发起 `item/tool/requestUserInput` 时，插件不再报错，而是把问题映射为 DSH 的 `ctx.userQuestions.ask()`（需要当前会话的 live agent），在 DSH 界面弹出问题对话框；用户作答后，答案按 App Server 协议格式（`{ answers: { [questionId]: { answers: string[] } } }`）返回给仍在运行的同一个 turn。

行为与边界：

- 问题、选项（label／description）和自由文本（`isOther`）会完整映射。App Server `0.148.0` 没有多选能力字段，因此 DSH 对话框默认使用单选语义；返回给 App Server 的答案仍按协议使用字符串数组。
- **secret 问题（`isSecret: true`）保持明确失败**：DSH 提问 UI 没有脱敏输入，拒绝把密码类输入明文展示。
- **没有 live agent 时明确失败**：一次性／无代理调用无法回答问题，不会猜测。
- 等待回答期间暂停 `turnTimeoutMs` 空闲期限；所属会话销毁或插件卸载会取消等待并关闭回合。
- `isBlocking` 不区分处理：JSON-RPC 请求的响应就是唯一答案通道，一律桥接。
- **持久性限制**：桥接得到的回答只存在于 App Server turn 内，不写入 DSH 会话日志；因此当工具目录变化必须重建 thread、或会话需要从 DSH 历史恢复时，这类问答交互无法无损重建（与下方 reasoning／assistant 图片限制同类）。

## 已知限制

- 重建 App Server 线程时（例如工具目录变化、或从其他 provider 切换过来），历史中的 reasoning 块不会被重新导入——Responses 后端不接受客户端注入的 reasoning item。reasoning 摘要仍完整保留在 DSH 会话日志与 Source 中，文本和工具历史照常导入，会话可继续使用。
- assistant 图片无法导入 App Server；若重建线程时遇到 assistant 图片，插件会明确失败并要求新建会话，而不是静默丢弃。
- App Server 无法兑现的普通对话配置字段（`temperature`、`maxTokens`、`stop`）会被拒绝，不会被静默忽略。仅 DSH 自带的 `compaction`／`session-title` 辅助请求允许 `maxTokens` 作为无法下传的提示值。
- App Server `model/list` 不提供上下文容量。未配置容量且尚未收到 token-usage 实测值时，插件会把容量标为未知；这可能使 DSH 无法在首轮溢出前自动压缩。

所有权和协议细节见 [docs/architecture.md](docs/architecture.md)。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
RUN_CODEX_TOOL_LIVE=1 pnpm run test:live
RUN_CODEX_IMAGE_LIVE=1 pnpm run test:live
```

三条 live 测试分别验证真实图片输入、DSH 动态工具的暂停／续跑／steer／目录继承与更新，以及图片生成和 PNG 回写。它们都会使用宿主机现有的 Codex 登录；图片生成测试只应在确实需要验证该能力时执行。

## License

MIT
