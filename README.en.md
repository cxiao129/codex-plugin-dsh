# codex-plugin-dsh

[中文](https://github.com/wingoo/codex-plugin-dsh/blob/main/README.md) | English

![Local Codex App Server provider architecture for DeepSeek Harness](docs/assets/codex-dsh-hero.png)

Use the Codex account already signed in on your computer directly from DeepSeek Harness. No OpenAI API key needs to be configured in DSH. After installing the plugin and restarting DSH, select a model from **Codex App Server (local)** in the existing model selector and start chatting.

DSH continues to own the conversation and tool execution, so the existing DSH plugin and tool ecosystem remains available. Model requests reach the current Codex account through the local Codex App Server. The plugin also supports image input and writes native Codex image-generation results back into the DSH conversation.

## Quick install through DSH

In a DSH session with full host permissions, send this prompt:

```text
Install github:wingoo/codex-plugin-dsh into the current DSH web profile without modifying DeepSeek Harness source.

1. Check whether a Codex CLI version that satisfies the plugin requirements is installed. If it is missing or outdated, install or upgrade it using the official OpenAI method.
2. Run codex login status. If Codex is not signed in, ask me to run codex login in a terminal on the DSH host. Wait until I complete the browser flow and reply "signed in" before continuing.
3. Confirm that codex app-server --help succeeds.
4. Install the plugin and use dsh --profile web --dump-config to confirm that codex-app-server-provider is loaded.
5. Restart the current DSH Web service using its original launch method without starting a second instance on the same port. Before restarting, tell me that the connection will be interrupted.
6. When the service returns, tell me to refresh the page and select Codex App Server (local) in the existing model selector.

If the original launch method cannot be determined reliably, do not guess or terminate unrelated processes. Give me the exact restart command instead.
```

This modifies the DSH profile and executes plugin code on the host, so verify the repository source first. The active connection will briefly drop during the restart; refresh the page after the service returns.

## Install from the command line

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

When running DeepSeek Harness from its source checkout:

```sh
pnpm dsh plugin --profile web add github:wingoo/codex-plugin-dsh
```

Before a versioned release exists, pin a tested commit for a reproducible installation:

```sh
dsh plugin --profile web add github:wingoo/codex-plugin-dsh#<commit-sha>
```

## Install a local checkout

```sh
dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/codex-plugin-dsh
```

## Use it after installation

Restart DSH Web using its original launch method; do not start a second instance on the same port. When the service returns, refresh the browser, open the existing model selector below the composer, and select a model from **Codex App Server (local)**.

A blank workspace initially uses the current default model. You can switch to Codex before sending the first message.

## Update an installed plugin through DSH

An installed copy does not need to be removed first. Send the following prompt to a DSH session with full host access:

```text
Update the installed codex-plugin-dsh in the current DSH web profile to the latest GitHub main revision. Do not modify DeepSeek Harness source and do not remove the plugin first.

1. Run command -v dsh to check whether this environment can invoke dsh directly.
2. If it can, run dsh plugin --profile web update codex-plugin-dsh. If there is no global dsh command and the current service was launched through npx, use npx --yes @deepseek-ai/dsh plugin --profile web update codex-plugin-dsh instead.
3. Inspect ~/.dsh/profiles/web/pnpm-lock.yaml and confirm that the GitHub tarball commit for codex-plugin-dsh changed. Also run dsh --profile web --dump-config, using the corresponding npx command when applicable, and confirm that codex-app-server-provider is still present.
4. After the update succeeds, restart the existing Web service with its original launch method. Do not start a second instance on the same port. Warn me before the connection is interrupted.
5. After the service returns, remind me to refresh the page and test a Codex model in a new conversation.

If the sandbox blocks the update, request only the permission required for that operation. If the original launch method cannot be determined reliably, do not guess or terminate unrelated processes; tell me the restart command I should run.
```

The update refreshes the commit resolved for the GitHub dependency while preserving the existing plugin bundle entry in the web profile.

### Update from a terminal

With a globally installed `dsh` command:

```sh
dsh plugin --profile web update codex-plugin-dsh
```

When DSH is run through `npx`:

```sh
npx --yes @deepseek-ai/dsh plugin --profile web update codex-plugin-dsh
```

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web update codex-plugin-dsh
```

Restart the existing DSH Web service after the update. A running process does not automatically load new plugin code from disk.

## Requirements

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness `0.1.1-rc.2` (plugin dependencies are pinned to this verified host)
- A local Codex CLI `>=0.148.0`
- A Codex account signed in through `codex login`

### Prepare the Codex CLI

The plugin uses the Codex CLI installed on the DSH host. It does not download, upgrade, or sign in to Codex for you. Prepare the runtime using the [OpenAI Codex CLI](https://github.com/openai/codex) installation:

```sh
npm install -g @openai/codex
codex login
```

Confirm that Codex is visible in the environment where DSH runs and that App Server is available:

```sh
codex --version
codex app-server --help
```

Codex CLI owns account authentication and product settings. The plugin does not read or store an API key, and no OpenAI API key needs to be entered in DSH.

## Current status

The current compatibility baseline is DeepSeek Harness `0.1.1-rc.2` with Codex CLI `0.148.0` on macOS. Regression coverage includes DSH `prepareCall`, provider retry policy, ReplayEnvelope, `session/disposed` ownership, compaction/session-title auxiliary calls, context-capacity metadata, image input/output, and dynamic-tool pause/resume.

Windows batch-shim startup has unit coverage but still needs a real Windows host run. Runtime DSH packages and development dependencies are pinned to the verified `0.1.1-rc.2` host to prevent cross-prerelease interface mixing.

## Configuration

Installation activates the provider with safe defaults. A profile can override the inserted plugin row in its own `cordis.patch.yml`:

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

`executable` is resolved by DSH in the subprocess provider's execution environment, so a remote or sandbox subprocess provider must make Codex available in that same environment. `env` is an explicit child-process overlay; do not put credentials in a committed profile.

`turnTimeoutMs` is an App Server inactivity deadline and defaults to 60 minutes so long reasoning and transient network stalls do not abandon a live turn. It is suspended while App Server waits for a DSH dynamic-tool result or a human answer, then restarted after that request settles. `contextWindowTokens` is a global fallback when the model catalog has no capacity metadata, and `modelContextWindows` overrides it by model ID. The plugin declares 1,048,576 tokens for `gpt-5.6-sol` by default and makes no capacity claim for other models. A context window later reported by an App Server token-usage notification takes precedence. Configure a reliable capacity explicitly for other models when DSH must schedule automatic compaction before the first turn. An empty `registryPath` uses the default sidecar location; override it only to isolate Host instances, and ensure those instances do not manage the same thread set. `ephemeralOneShotSubagents` defaults positively identified one-shot DSH child agents to ephemeral Codex threads while their DSH child Session, tool loop, and final settlement remain durable. `syncThreadNames` applies `[DSH]` / `[DSH 子代理]` prefixes to persistent threads. `subagentSectionName` selects the App Server Section for continuable or unclassified persistent child agents; set it to an empty string to disable grouping.

## Runtime behavior

- The DSH Agent Loop does not call a fixed HTTP API. It sends the current Session's selected provider and model through the DSH LLM service; selecting Codex routes the request to this plugin and then over stdio to the local Codex App Server. A DSH default model only affects new Sessions without an explicit selection and is not a second upstream for the Codex route.
- DSH assembles its system prompt and tools normally. The plugin consumes only that request's `options.tools`; it never enumerates the global registry again, so preset, scope, allow/deny, and code-mode decisions are neither bypassed nor duplicated.
- When App Server requests a dynamic tool in the `dsh` namespace, the plugin first emits an ordinary DSH `tool-call`. The DSH Agent Loop owns permission checks, scheduling, execution, and `tool/call` / `tool/result` logs. The pending App Server RPC suspends the inactivity deadline, so a tool or human wait longer than the default sixty-minute deadline is not closed. The Provider step that receives the result returns it to the same App Server turn. That continuation stays pinned to the original App Server turn's model and tool catalog: if a UI selection or reassembly changed meanwhile, the already-issued tool call completes safely first and the change applies after the App Server turn closes. The plugin does not execute the tool a second time. Session disposal, plugin unload, or genuine inactivity outside an outstanding request still closes the process and explicitly rejects pending RPCs.
- DSH image tool results return to Codex as dynamic-tool image output. Tool `additionalContexts` enter the active turn through `turn/steer` instead of being folded into the tool result.
- An App Server thread retains its dynamic-tool catalog. If the Session still owns an active turn waiting for a dynamic-tool result, the next provider step continues that turn first, pinned to its original model and catalog. Otherwise the plugin calls `thread/read`: it uses `thread/resume` only when the replay checkpoint is exactly the remote completed head, and uses `thread/fork` from the DSH checkpoint only for a failed turn, an externally appended turn, or another head divergence. A changed catalog starts a new thread and rebuilds all importable history from durable DSH messages.
- The DSH workspace is the App Server thread working directory, but App Server is pinned to a read-only sandbox and `never` approval. Codex-native shell, file mutation, Web, MCP, Apps, Plugins, view-image, and multi-agent capabilities are disabled or denied; those actions must use DSH tools.
- Native Codex image generation is the intentional exception. App Server performs it directly instead of routing it through the DSH tool loop.
- DSH image attachments are verified by the attachment service and sent to App Server as inline data URLs, without relying on a shared local filesystem path.
- Completed App Server image generations are saved as DSH image attachments and displayed as assistant images in the existing conversation. Image-generation availability depends on the selected Codex account, model, and App Server capabilities; no separate OpenAI API key is required in DSH.
- Successful turns persist the App Server thread, turn, and tool-catalog signature in the DSH model replay state. The DSH Session Log is the source of truth: if the checkpoint's App Server thread is missing, the plugin creates a new owned thread and rebuilds every representable item from DSH history instead of losing context.
- Completed text, user-image, and tool history from another DSH provider is imported through App Server's `thread/inject_items` method when a session switches to Codex. When synthetic DSH user context (for example, a subagent settlement notice) carries `reasoning`, `tool-call`, or nested `tool-result` blocks, the adapter projects them as explicitly labeled inert text/image context; copied tool calls are never executed in the parent thread and never become dangling App Server function calls.
- The App Server process is owned by DSH's subprocess service, including startup before a turn is published. One process may span several DSH tool steps and DSH turn boundaries while an interactive result is pending. `session/disposed` and plugin unload first cancel and await unfinished initialize/read/resume/fork/turn-start work, then close published processes, so a late startup cannot leak a turn after teardown. Completion and genuine inactivity outside an outstanding request also terminate the process tree.
- The Session header's `origin: subagent` marker and the first durable `subagent/descriptor` in the child's own event suffix determine sidebar presentation; an ancestor descriptor inherited through a fork seed is ignored. Only a child positively identified as `one-shot` becomes ephemeral; a missing or unsupported descriptor fails closed to a persistent thread. An ephemeral one-shot still keeps one live App Server turn across DSH dynamic-tool steps, but publishes neither a creation receipt nor terminal replay state.
- Persistent main threads use the latest DSH `session/title`, falling back to the first direct human message, and are named through `thread/name/set` with a `[DSH]` prefix. Persistent child agents use their descriptor label or human title, receive a `[DSH 子代理]` prefix, and move into the configured App Server Section. Naming and grouping are best-effort presentation only and never block model routing; the DSH Session Log and child topology remain authoritative.
- DSH `compaction` and `session-title` auxiliary calls use separate ephemeral App Server threads. They never inherit or consume a conversational turn that is waiting for a tool result, and expose no dynamic tools, interactive questions, or replay state. They may carry `maxTokens`; Codex App Server `0.148.0` has no matching turn field, so the plugin treats that auxiliary bound as advisory and allows the call to proceed. Ordinary-conversation `maxTokens` remains an explicit error rather than silently ignoring user configuration.

## Thread registry and governance

The plugin maintains a repairable sidecar registry (default `~/.dsh/codex-plugin-dsh/thread-registry.json`) containing creation receipts for plugin-owned threads, each DSH Session's canonical/branch references, and reference counts. The DSH Session Log remains the source of truth for conversation checkpoints. Reconciliation can rebuild references from durable Session history when the registry is missing or stale, but a thread discovered only from the log is never assumed to be plugin-owned.

Normal conversational start/read/resume/fork/rebuild paths never archive, unarchive, or delete an existing thread. Explicit lifecycle operations also fail closed: registry snapshots expose ownership, local active state, and current reference counts; archive accepts only unreleased, receipt-proven, unshared threads whose remote head is not `inProgress` according to a fresh `thread/read`; unarchive restores only owned threads archived by this registry; purge additionally requires explicit confirmation, released Session references, a fresh zero reference count, proven ownership, and another remote-active check before deletion. Corrupt registry storage is preserved rather than overwritten and reported as unhealthy; existing threads rebuilt from DSH logs without creation receipts remain unowned.

Run `pnpm dry-run:archive-threads [report-path]` before any legacy cleanup. It reads DSH Session logs, the ownership registry, and Codex SQLite presentation state to produce reason-coded `eligible_after_live_check`, `already_archived`, and `blocked` rows. It never calls archive/delete, never writes Codex SQLite, and omits titles, prompts, model output, and workspace paths. A future archive must still go through the registry lifecycle path and repeat both the local activity fence and fresh `thread/read`; the dry-run is not archive authorization.

Within one process, reconciliation is single-flight; new thread/turn startup and explicit lifecycle RPCs share one fence, while creation receipts, Session events, reconciliation, and management changes share one ordered state lock. This prevents a new turn or reference from appearing after the lifecycle checks. Every remote archive/unarchive/delete first persists a write-ahead intent and commits the projection afterward; if the final write fails, the intent remains in the sidecar and the same operation ID can safely retry/resume after restart instead of losing evidence of the remote mutation. Session/thread management operations are also serialized by key. These locks do not coordinate separate DSH processes; deployments must not let multiple Host processes manage the same registry or App Server thread set concurrently.

## Interactive question bridge (`requestUserInput`)

App Server `item/tool/requestUserInput` requests are mapped to `ctx.userQuestions.ask()` for the exact live DSH agent. The response is returned to the still-running App Server turn as `{ answers: { [questionId]: { answers: string[] } } }`.

- Questions, option labels/descriptions, and `isOther` free text are preserved. App Server `0.148.0` exposes no multi-select capability bit, so the DSH dialog defaults to single selection while the wire response remains an array.
- Secret questions fail explicitly because the DSH dialog has no masked-input contract.
- Agentless or delegated calls fail rather than guessing or blocking forever.
- The inactivity deadline is suspended while a human answer is pending. Owning-session disposal or plugin unload cancels the wait and closes the turn.
- The answer exists only in the App Server turn and is not a reconstructable DSH message. A rebuild caused by a tool-catalog change cannot replay that private interaction losslessly.

## Known limitations

- Reasoning blocks are not re-imported while rebuilding an App Server thread because the Responses backend rejects client-injected reasoning items. Their summaries remain in the DSH log and Source, while text and tool history continue normally.
- Assistant images cannot be imported into App Server. A rebuild that encounters one fails explicitly and asks for a new Session instead of silently dropping it.
- Ordinary-conversation fields that App Server cannot honor (`temperature`, `maxTokens`, and `stop`) are rejected. Only DSH's built-in `compaction` / `session-title` auxiliary requests may carry `maxTokens` as a non-forwardable advisory value.
- App Server `model/list` does not expose context capacity. Until a reliable configured value or a token-usage observation exists, the plugin reports it as unknown, which can prevent DSH from scheduling automatic compaction before a first-turn overflow.

See [docs/architecture.md](docs/architecture.md) for ownership and protocol details.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
RUN_CODEX_LIVE=1 pnpm run test:live
RUN_CODEX_TOOL_LIVE=1 pnpm run test:live
RUN_CODEX_IMAGE_LIVE=1 pnpm run test:live
```

The live commands cover real image input; dynamic DSH tool pause/resume, steering, catalog inheritance, and catalog replacement; and image generation with PNG persistence. They use the host's existing Codex login. Run the image-generation case only when that provider action is intended.

## License

MIT
