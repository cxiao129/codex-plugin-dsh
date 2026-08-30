import z from "@deepseek-ai/schemastery";
import { dirname, extname, join, resolve } from "node:path";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { foldSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
//#region src/validation.ts
/** Runtime validation helpers for values crossing the App Server JSON boundary. */
/** Return a JSON object or reject the named protocol value. */
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/** Return a non-empty string or reject the named protocol value. */
function string(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/** Normalize an unknown rejection into an Error without discarding its text. */
function thrown(value) {
	return value instanceof Error ? value : new Error(String(value));
}
//#endregion
//#region src/app-server.ts
/** Owned Codex App Server process and JSONL connection. */
var NotificationQueue = class {
	values = [];
	waiters = [];
	terminal;
	push(value) {
		if (this.terminal !== void 0) return;
		const waiter = this.waiters.shift();
		if (waiter === void 0) this.values.push(value);
		else waiter.resolve({
			done: false,
			value
		});
	}
	end() {
		this.settle({});
	}
	fail(error) {
		this.settle({ error });
	}
	settle(terminal) {
		if (this.terminal !== void 0) return;
		this.terminal = terminal;
		for (const waiter of this.waiters.splice(0)) if (terminal.error === void 0) waiter.resolve({
			done: true,
			value: void 0
		});
		else waiter.reject(terminal.error);
	}
	[Symbol.asyncIterator]() {
		return { next: () => {
			const value = this.values.shift();
			if (value !== void 0) return Promise.resolve({
				done: false,
				value
			});
			if (this.terminal?.error !== void 0) return Promise.reject(this.terminal.error);
			if (this.terminal !== void 0) return Promise.resolve({
				done: true,
				value: void 0
			});
			const waiter = Promise.withResolvers();
			this.waiters.push(waiter);
			return waiter.promise;
		} };
	}
};
/** One initialized or initializing App Server child. */
var CodexAppServerConnection = class {
	child;
	observer;
	closeTimeoutMs;
	transport;
	queue = new NotificationQueue();
	closing = false;
	failureReported = false;
	onStdinError = (error) => {
		if (this.closing) return;
		this.reportFailure(thrown(error));
	};
	constructor(child, requestHandler, observer, closeTimeoutMs = 1e4) {
		this.child = child;
		this.observer = observer;
		this.closeTimeoutMs = closeTimeoutMs;
		if (child.stdout === void 0 || child.stdin === void 0) throw new Error("codex-plugin-dsh: App Server subprocess requires piped stdin and stdout");
		child.stdin.on("error", this.onStdinError);
		this.transport = new JsonRpcLineTransport(child.stdout, child.stdin);
		this.transport.onRequest(requestHandler);
		this.transport.onNotification((method, params) => {
			const notification = {
				method,
				params
			};
			if (this.observer === void 0) this.queue.push(notification);
			else this.observer.notification(notification);
		});
		child.done.then((outcome) => {
			this.reportFailure(/* @__PURE__ */ new Error(`codex-plugin-dsh: App Server exited unexpectedly (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderrSuffix()}`));
		}, (error) => {
			this.reportFailure(thrown(error));
		});
	}
	/** Attach protocol listeners and perform the required initialize handshake. */
	async initialize(signal) {
		this.transport.start();
		object(await this.transport.request("initialize", {
			clientInfo: {
				name: "codex-plugin-dsh",
				title: "Codex Plugin for DeepSeek Harness",
				version: "0.1.0"
			},
			capabilities: {
				experimentalApi: true,
				requestAttestation: false
			}
		}, signal), "initialize response");
		this.transport.notify("initialized", {});
		await this.transport.flush();
	}
	/** Send one typed-by-caller App Server request. */
	async request(method, params, signal) {
		return object(await this.transport.request(method, params, signal), `${method} response`);
	}
	/** Send a best-effort interrupt for an active turn. */
	interrupt(threadId, turnId) {
		if (this.closing) return;
		this.transport.request("turn/interrupt", {
			threadId,
			turnId
		}).catch(() => {});
	}
	/** Notifications emitted by this single-operation connection. */
	notifications() {
		return this.queue;
	}
	/** Terminate the managed process tree and wait until it is gone. Idempotent. */
	async close() {
		if (this.closing) return;
		this.closing = true;
		this.queue.end();
		this.transport.close();
		try {
			this.child.stdin?.end();
		} catch {}
		this.child.terminate();
		if (await this.child.waitForExit(AbortSignal.timeout(this.closeTimeoutMs))) await this.child.done.catch(() => {});
	}
	reportFailure(error) {
		if (this.closing || this.failureReported) return;
		this.failureReported = true;
		if (this.observer === void 0) this.queue.fail(error);
		else this.observer.failure(error);
	}
	stderrSuffix() {
		const text = (this.child.collected.stderr?.readFrom(0))?.text.trim();
		return text === void 0 || text.length === 0 ? "" : `: ${text}`;
	}
};
//#endregion
//#region src/history.ts
function codexReplayState(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const envelope = value;
	const raw = "response" in envelope ? envelope.response : envelope;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const candidate = raw;
	if (candidate.kind !== "codex-app-server" || candidate.version !== 1) return void 0;
	if (typeof candidate.threadId !== "string" || candidate.threadId.length === 0) return void 0;
	if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) return void 0;
	if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return void 0;
	return {
		kind: "codex-app-server",
		version: 1,
		threadId: candidate.threadId,
		turnId: candidate.turnId,
		sessionId: candidate.sessionId,
		...typeof candidate.toolSignature === "string" && candidate.toolSignature.length > 0 ? { toolSignature: candidate.toolSignature } : {}
	};
}
function latestCheckpoint(messages, provider) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.source.kind !== "model" || message.source.provider !== provider) continue;
		const state = codexReplayState(message.source.replayState);
		if (state === void 0) {
			if (message.content.some((block) => block.type === "tool-call")) continue;
			throw new Error("codex-plugin-dsh: a prior Codex response has no compatible App Server checkpoint; start a new session");
		}
		return {
			index,
			state
		};
	}
}
function textBlocks(blocks, label) {
	return blocks.map((block) => {
		if (block.type !== "text") throw new Error(`codex-plugin-dsh: ${label} contains unsupported ${JSON.stringify(block.type)} content`);
		return block.text;
	});
}
function isCurrentTurnInput(message) {
	return message.role === "user" && message.source.kind !== "tool" && message.content.length > 0;
}
function inertToolCallText(block) {
	const argumentsText = block.arguments.trim();
	const header = `[DSH tool call ${JSON.stringify(block.name)} copied as context; not executed in this thread]`;
	return argumentsText === "" ? header : `${header}\n${argumentsText}`;
}
async function normalizedInputContent(blocks, label, resolveImageUrl) {
	const content = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text,
				text_elements: []
			});
			break;
		case "image":
			content.push({
				type: "image",
				url: await resolveImageUrl(block.attachment)
			});
			break;
		case "reasoning":
			content.push({
				type: "text",
				text: `[DSH reasoning summary copied as context]\n${block.text}`,
				text_elements: []
			});
			break;
		case "tool-call":
			content.push({
				type: "text",
				text: inertToolCallText(block),
				text_elements: []
			});
			break;
		case "tool-result":
			content.push({
				type: "text",
				text: `[DSH embedded tool result for ${JSON.stringify(block.toolCallId)}${block.isError === true ? "; error" : ""}]`,
				text_elements: []
			});
			content.push(...await normalizedInputContent(block.content, `${label} embedded tool result ${JSON.stringify(block.toolCallId)}`, resolveImageUrl));
			break;
		default: throw new Error(`codex-plugin-dsh: ${label} contains a plugin-defined content block that App Server cannot import`);
	}
	return content;
}
async function inputContent(blocks, label, resolveImageUrl) {
	return (await normalizedInputContent(blocks, label, resolveImageUrl)).map((input) => input.type === "text" ? {
		type: "input_text",
		text: input.text
	} : {
		type: "input_image",
		image_url: input.url
	});
}
async function toolOutput(block, resolveImageUrl) {
	const label = `tool result ${JSON.stringify(block.toolCallId)}`;
	if (block.content.every((item) => item.type === "text")) return textBlocks(block.content, label).join("\n");
	return inputContent(block.content, label, resolveImageUrl);
}
async function userHistoryItem(message, resolveImageUrl) {
	if (message.source.kind === "tool") {
		if (message.content.length !== 1 || message.content[0]?.type !== "tool-result") throw new Error("codex-plugin-dsh: a DSH tool message has invalid tool-result content");
		const block = message.content[0];
		return [{
			type: "function_call_output",
			call_id: block.toolCallId,
			output: await toolOutput(block, resolveImageUrl)
		}];
	}
	return [{
		type: "message",
		role: message.role,
		content: await inputContent(message.content, "user history", resolveImageUrl)
	}];
}
function assistantHistoryItems(message) {
	const items = [];
	let text = [];
	const flushText = () => {
		if (text.length === 0) return;
		items.push({
			type: "message",
			role: "assistant",
			status: "completed",
			content: text
		});
		text = [];
	};
	for (const block of message.content) switch (block.type) {
		case "text":
			text.push({
				type: "output_text",
				text: block.text,
				annotations: []
			});
			break;
		case "tool-call":
			flushText();
			items.push({
				type: "function_call",
				call_id: block.id,
				name: block.name,
				arguments: block.arguments,
				status: "completed"
			});
			break;
		case "reasoning": break;
		case "image":
		case "tool-result": throw new Error(`codex-plugin-dsh: assistant history contains unsupported ${JSON.stringify(block.type)} content`);
		default: throw new Error("codex-plugin-dsh: assistant history contains a plugin-defined content block that App Server cannot import");
	}
	flushText();
	return items;
}
/** Map completed DSH history to raw Responses items accepted by `thread/inject_items`. */
async function responseItems(messages, resolveImageUrl) {
	return (await Promise.all(messages.map(async (message) => {
		if (message.role === "assistant") return assistantHistoryItems(message);
		if (message.role === "user" || message.role === "system") return userHistoryItem(message, resolveImageUrl);
		throw new Error(`codex-plugin-dsh: unsupported history role ${JSON.stringify(message.role)}`);
	}))).flat();
}
/**
* Split a DSH request into a pinned Codex checkpoint, completed history to import, and current user input.
* @param messages - Exact DSH provider message sequence for this request.
* @param provider - Registered Codex provider route.
* @param ignoreCheckpoint - Rebuild from DSH history instead of reusing a persisted Codex thread.
* @param sessionId - Exact live DSH session identity; a checkpoint from a forked
*   or copied session is rebuilt instead of reusing the parent App Server thread.
* @returns Work required to construct the matching App Server thread.
*/
async function prepareCodexHistory(messages, provider, resolveImageUrl, ignoreCheckpoint = false, sessionId) {
	const candidate = ignoreCheckpoint ? void 0 : latestCheckpoint(messages, provider);
	const checkpoint = candidate !== void 0 && (sessionId === void 0 || candidate.state.sessionId === sessionId) ? candidate : void 0;
	const pending = checkpoint === void 0 ? messages : messages.slice(checkpoint.index + 1);
	let inputStart = pending.length;
	while (inputStart > 0 && isCurrentTurnInput(pending[inputStart - 1])) inputStart -= 1;
	const historical = pending.slice(0, inputStart);
	const current = pending.slice(inputStart);
	if (current.length === 0) throw new Error("codex-plugin-dsh: the current Codex turn has no user input");
	const turnInput = (await Promise.all(current.map((message) => normalizedInputContent(message.content, "current user input", resolveImageUrl)))).flat();
	if (turnInput.every((input) => input.type === "text" && input.text.trim().length === 0)) throw new Error("codex-plugin-dsh: the current Codex turn is empty");
	return {
		...checkpoint === void 0 ? {} : { checkpoint: checkpoint.state },
		injectItems: await responseItems(historical, resolveImageUrl),
		turnInput
	};
}
//#endregion
//#region src/thread-state.ts
/**
* Reuse a persistent thread only when the DSH checkpoint is exactly its completed
* head. Any additional, failed, interrupted, or unknown head is a real divergence
* and must fork from the last DSH-committed turn.
*/
function decideThreadContinuation(checkpointTurnId, snapshot) {
	return snapshot.headTurnId === checkpointTurnId && snapshot.headTurnStatus === "completed" ? "resume" : "fork";
}
//#endregion
//#region src/images.ts
/** Convert a verified DSH image reference to an inline App Server image URL. */
async function attachmentDataUrl(attachments, ref, signal) {
	const stored = await attachments.readImage(ref, signal);
	return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
}
function decodePngBase64(value) {
	if (typeof value !== "string") throw new Error("codex-plugin-dsh: completed App Server image generation has no base64 result");
	const encoded = value.trim();
	if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) throw new Error("codex-plugin-dsh: App Server returned invalid generated-image base64");
	return Uint8Array.from(Buffer.from(encoded, "base64"));
}
/** Persist one completed App Server image-generation item as a DSH image block. */
async function generatedImageBlock(attachments, item) {
	if (item.status !== "completed") return void 0;
	return {
		type: "image",
		attachment: await attachments.saveImage({
			data: decodePngBase64(item.result),
			mediaType: "image/png",
			name: "codex-generated.png"
		})
	};
}
//#endregion
//#region src/presentation.ts
const MAIN_PREFIX = "[DSH]";
const SUBAGENT_PREFIX = "[DSH 子代理]";
const BACKGROUND_PREFIX = "[DSH 后台]";
const TITLE_LIMIT = 80;
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function normalizedTitle(value) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return void 0;
	const points = Array.from(normalized);
	return points.length <= TITLE_LIMIT ? normalized : `${points.slice(0, 79).join("")}…`;
}
/** Read the latest durable DSH title without requiring the optional title service at runtime. */
function loggedSessionTitle(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type !== "session/title") continue;
		const title = record(event.data)?.title;
		if (typeof title === "string") return normalizedTitle(title);
	}
}
/** Fall back to the first direct human message, excluding synthetic DSH user context. */
function firstHumanTitle(events) {
	for (const raw of events) {
		const event = raw;
		if (event.type !== "user/message") continue;
		const message = record(event.data);
		if (record(message?.source)?.kind !== "user" || !Array.isArray(message?.content)) continue;
		const title = normalizedTitle(message.content.map((block) => {
			const item = record(block);
			return item?.type === "text" && typeof item.text === "string" ? item.text : "";
		}).filter(Boolean).join(" "));
		if (title !== void 0) return title;
	}
}
function displayName(prefix, title, fallback) {
	return `${prefix} ${title ?? fallback}`;
}
/** Exclude inherited fork-seed events when classifying the current Session. */
function ownSessionEvents(session) {
	const seedLength = session.header.seedLength;
	if (seedLength === void 0 || !Number.isSafeInteger(seedLength) || seedLength <= 0) return session.events;
	return session.events.filter((event) => event.seq >= seedLength);
}
/**
* Resolve a fail-closed presentation policy from durable Session metadata.
* Unknown or unsupported subagent descriptors stay persistent and grouped:
* only a positively identified one-shot child is eligible for ephemeral mode.
*/
function resolveThreadPresentation(session, policy) {
	const ownEvents = ownSessionEvents(session);
	const title = loggedSessionTitle(ownEvents) ?? firstHumanTitle(ownEvents);
	if (session.header.origin !== "subagent") return {
		kind: "main",
		ephemeral: false,
		...policy.syncThreadNames ? { name: displayName(MAIN_PREFIX, title, "会话") } : {}
	};
	const descriptor = foldSubagentDescriptor(ownEvents);
	const sectionName = policy.subagentSectionName?.trim() || void 0;
	if (descriptor?.mode === "one-shot") {
		const ephemeral = policy.ephemeralOneShotSubagents;
		return {
			kind: "one-shot-subagent",
			ephemeral,
			...!ephemeral && policy.syncThreadNames ? { name: displayName(BACKGROUND_PREFIX, descriptor.label ?? title, "一次性任务") } : {},
			...!ephemeral && sectionName !== void 0 ? { sectionName } : {}
		};
	}
	if (descriptor?.mode === "continuable") return {
		kind: "continuable-subagent",
		ephemeral: false,
		...policy.syncThreadNames ? { name: displayName(SUBAGENT_PREFIX, descriptor.label || title, "可继续任务") } : {},
		...sectionName === void 0 ? {} : { sectionName }
	};
	return {
		kind: "unknown-subagent",
		ephemeral: false,
		...policy.syncThreadNames ? { name: displayName(SUBAGENT_PREFIX, title, "任务") } : {},
		...sectionName === void 0 ? {} : { sectionName }
	};
}
function requiredString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value;
}
/**
* Map the exact DSH tool schemas assembled for a provider request to one Codex namespace.
* @param tools - Tool schemas after DSH preset, scope, and policy assembly.
* @returns Experimental App Server dynamic-tool declarations.
*/
function codexDynamicTools(tools) {
	if (tools === void 0 || tools.length === 0) return [];
	return [{
		type: "namespace",
		name: "dsh",
		description: "Tools assembled and executed by DeepSeek Harness for this session.",
		tools: tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters
		}))
	}];
}
/**
* Fingerprint the model-visible DSH tool catalog retained by an App Server thread.
* @param tools - Exact DSH tool schemas for the provider request.
* @returns Stable SHA-256 digest used to avoid redundant registrations.
*/
function codexToolSignature(tools) {
	return createHash("sha256").update(JSON.stringify(codexDynamicTools(tools))).digest("hex");
}
/**
* Validate one App Server dynamic-tool request before exposing it to the DSH loop.
* @param params - Raw `item/tool/call` parameters.
* @param availableTools - Exact DSH tool names registered for the active turn.
* @returns Validated dynamic-tool call.
*/
function codexDynamicToolCall(params, availableTools) {
	const namespace = requiredString(params.namespace, "dynamic tool namespace");
	if (namespace !== "dsh") throw new Error(`codex-plugin-dsh: App Server requested unsupported dynamic tool namespace ${JSON.stringify(namespace)}`);
	const tool = requiredString(params.tool, "dynamic tool name");
	if (!availableTools.has(tool)) throw new Error(`codex-plugin-dsh: App Server requested unregistered DSH tool ${JSON.stringify(tool)}`);
	return {
		threadId: requiredString(params.threadId, "dynamic tool thread id"),
		turnId: requiredString(params.turnId, "dynamic tool turn id"),
		callId: requiredString(params.callId, "dynamic tool call id"),
		namespace: "dsh",
		tool,
		arguments: params.arguments
	};
}
function matchingToolResult(messages, callId) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user" || message.source.kind !== "tool" || String(message.source.callId) !== callId) continue;
		if (message.content.length !== 1 || message.content[0]?.type !== "tool-result") throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has invalid content`);
		if (String(message.content[0].toolCallId) !== callId) throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(callId)} has mismatched correlation`);
		return {
			index,
			block: message.content[0]
		};
	}
	throw new Error(`codex-plugin-dsh: DSH did not return tool result ${JSON.stringify(callId)}`);
}
/**
* Convert the DSH loop's logged tool result into the pending App Server response.
* @param messages - Current DSH provider message sequence after tool execution.
* @param callId - Pending App Server call identity.
* @param resolveImageUrl - Durable-image resolver for nested tool output.
* @returns Dynamic-tool response and later DSH context consumed by the still-running App Server turn.
*/
async function codexDynamicToolResult(messages, callId, resolveImageUrl) {
	const matched = matchingToolResult(messages, String(callId));
	const contentItems = await Promise.all(matched.block.content.map(async (block) => {
		if (block.type === "text") return {
			type: "inputText",
			text: block.text
		};
		if (block.type === "image") return {
			type: "inputImage",
			imageUrl: await resolveImageUrl(block.attachment)
		};
		throw new Error(`codex-plugin-dsh: DSH tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`);
	}));
	const steerInput = (await Promise.all(messages.slice(matched.index + 1).map(async (message) => {
		if (message.role === "assistant" || message.source.kind === "tool") throw new Error(`codex-plugin-dsh: unexpected message followed DSH tool result ${JSON.stringify(String(callId))}`);
		return Promise.all(message.content.map(async (block) => {
			if (block.type === "text") return {
				type: "text",
				text: block.text,
				text_elements: []
			};
			if (block.type === "image") return {
				type: "image",
				url: await resolveImageUrl(block.attachment)
			};
			throw new Error(`codex-plugin-dsh: context after tool result ${JSON.stringify(String(callId))} contains unsupported ${JSON.stringify(block.type)} content`);
		}));
	}))).flat();
	return {
		response: {
			contentItems,
			success: matched.block.isError !== true
		},
		steerInput
	};
}
//#endregion
//#region src/adapter.ts
/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */
/** Provider route registered in the existing DSH model catalog. */
const CODEX_APP_SERVER_PROVIDER = "codex-app-server";
const CODEX_RETRY_POLICY = resolveRetryPolicy({
	mode: "normal",
	maxRetries: 0
}, "codex-plugin-dsh.retry");
/** Provider instructions that separate DSH dynamic tools from Codex host capabilities. */
const CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS = [
	"DeepSeek Harness owns tool selection, permission checks, execution, and durable tool logs.",
	"Use only tools in the dsh dynamic-tool namespace for shell, files, web, code changes, and other actions represented in the DSH tool catalog.",
	"Do not use built-in shell, apply_patch, web search, MCP, app, plugin, multi-agent, or view-image tools.",
	"The dsh skill tool loads only names listed in the DSH <available_skills> catalog included in the conversation; never use it to load Codex host skills or capabilities.",
	"For image creation or editing, use Codex host imagegen and native image generation directly; never call the dsh skill tool with the name imagegen."
].join(" ");
const WINDOWS_EXECUTABLE_ENV = "DSH_CODEX_APP_SERVER_EXECUTABLE";
var ActiveTurnQueue = class {
	values = [];
	waiters = [];
	terminal;
	push(event) {
		if (this.terminal !== void 0) {
			if (event.kind === "dynamic-tool") event.response.reject(this.terminal);
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter === void 0) this.values.push(event);
		else waiter.resolve(event);
	}
	fail(error) {
		if (this.terminal !== void 0) return;
		this.terminal = error;
		for (const event of this.values.splice(0)) if (event.kind === "dynamic-tool") event.response.reject(error);
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
	async next(signal) {
		signal.throwIfAborted();
		const value = this.values.shift();
		if (value !== void 0) return value;
		if (this.terminal !== void 0) throw this.terminal;
		const waiter = Promise.withResolvers();
		this.waiters.push(waiter);
		const onAbort = () => {
			waiter.reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await waiter.promise;
		} finally {
			signal.removeEventListener("abort", onAbort);
			const index = this.waiters.indexOf(waiter);
			if (index >= 0) this.waiters.splice(index, 1);
		}
	}
};
/**
* Build the fixed App Server command without allowing configured text into a Windows command tail.
* @param executable - Absolute executable path resolved by the DSH subprocess provider.
* @param env - Explicit child environment from plugin configuration.
* @param platform - Host platform selecting the Windows batch-shim path.
* @param commandInterpreter - Resolved Windows command interpreter.
* @returns Child argv and environment for the managed subprocess.
*/
function codexAppServerInvocation(executable, env, platform = process.platform, commandInterpreter = "cmd.exe") {
	const extension = extname(executable).toLowerCase();
	if (platform !== "win32" || extension !== ".cmd" && extension !== ".bat") return {
		argv: [
			executable,
			"app-server",
			"--stdio"
		],
		env
	};
	return {
		argv: [
			commandInterpreter,
			"/d",
			"/v:off",
			"/s",
			"/c",
			`%${WINDOWS_EXECUTABLE_ENV}%`,
			"app-server",
			"--stdio"
		],
		env: {
			...env,
			[WINDOWS_EXECUTABLE_ENV]: `"${executable}"`
		}
	};
}
function combinedSignal(parent, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent === void 0 ? timeout : AbortSignal.any([parent, timeout]);
}
/** Resettable inactivity deadline for one retained App Server turn. */
var TurnIdleDeadline = class {
	timeoutMs;
	controller = new AbortController();
	timer;
	holds = 0;
	constructor(timeoutMs) {
		this.timeoutMs = timeoutMs;
		this.touch();
	}
	get signal() {
		return this.controller.signal;
	}
	touch() {
		if (this.controller.signal.aborted || this.holds > 0) return;
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.controller.abort(new DOMException(`codex-plugin-dsh: App Server turn was idle for ${this.timeoutMs}ms`, "TimeoutError"));
		}, this.timeoutMs);
		this.timer.unref?.();
	}
	/**
	* Suspend the inactivity deadline while an App Server request is waiting on
	* DSH or a human. The returned release function is idempotent and restarts a
	* fresh idle window after the final outstanding request settles.
	*/
	hold() {
		if (this.controller.signal.aborted) return () => {};
		this.holds += 1;
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = void 0;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds = Math.max(0, this.holds - 1);
			if (this.holds === 0) this.touch();
		};
	}
	dispose() {
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = void 0;
		this.holds = 0;
	}
};
/** Scope one DSH provider step without shortening the retained App Server turn. */
function stepSignal(turnSignal, requestSignal) {
	return requestSignal === void 0 ? turnSignal : AbortSignal.any([turnSignal, requestSignal]);
}
function abortError(signal) {
	return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error(`codex-plugin-dsh: operation aborted: ${String(signal.reason)}`);
}
function phaseOf(value) {
	if (value === void 0 || value === null) return null;
	if (value === "commentary" || value === "final_answer") return value;
	throw new Error(`codex-plugin-dsh: App Server returned unknown agent message phase ${JSON.stringify(value)}`);
}
function blockType(phase) {
	return phase === "commentary" ? "reasoning" : "text";
}
/** Join the public reasoning-summary parts carried by one App Server item. */
function reasoningSummaryText(value, label) {
	if (!Array.isArray(value)) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`);
	return value.map((part, index) => {
		if (typeof part !== "string") throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}[${index}]`);
		return part;
	}).join("");
}
/** Materialize one public reasoning-summary fragment as ordinary DSH stream chunks. */
function appendReasoningSummary(active, itemId, text) {
	if (text.length === 0) return [];
	let block = active.blocks.get(itemId);
	const chunks = [];
	if (block === void 0) {
		block = {
			index: active.nextBlockIndex++,
			type: "reasoning",
			phase: "commentary",
			text: "",
			ended: false
		};
		active.blocks.set(itemId, block);
		chunks.push({
			type: "block-start",
			index: block.index,
			blockType: "reasoning"
		});
	}
	if (block.type !== "reasoning" || block.ended) throw new Error("codex-plugin-dsh: App Server emitted reasoning after its item completed");
	block.text += text;
	chunks.push({
		type: "reasoning-delta",
		index: block.index,
		text
	});
	return chunks;
}
function messageText(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
	const message = value.message;
	return typeof message === "string" ? message : JSON.stringify(value);
}
function missingThread(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /thread.{0,80}(?:not found|does not exist|unknown|missing)|(?:not found|does not exist).{0,80}thread/i.test(message);
}
function recordValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Validate one App Server thread response and read its chronological head turn. */
function threadResponse(value, label, requireTurns = false) {
	const thread = object(value.thread, `${label} thread`);
	const id = string(thread.id, `${label} thread id`);
	if (thread.turns === void 0 && !requireTurns) return { id };
	if (!Array.isArray(thread.turns)) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label} thread turns`);
	const last = thread.turns.at(-1);
	if (last === void 0) return { id };
	const turn = object(last, `${label} head turn`);
	return {
		id,
		headTurnId: string(turn.id, `${label} head turn id`),
		headTurnStatus: string(turn.status, `${label} head turn status`)
	};
}
function turnFailure(turn) {
	const error = turn.error;
	const detail = error === void 0 || error === null ? "" : `: ${messageText(error)}`;
	return new LlmError(`Codex App Server turn ended with status ${String(turn.status)}${detail}`, "CODEX_APP_SERVER");
}
function contextWindowExceeded(turn) {
	if (turn.status !== "failed" || turn.error === null || typeof turn.error !== "object" || Array.isArray(turn.error)) return false;
	return turn.error.codexErrorInfo === "contextWindowExceeded";
}
function usageFrom(value) {
	const last = object(object(value, "token usage").last, "last-turn token usage");
	const integer = (field) => {
		const count = last[field];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`codex-plugin-dsh: App Server returned invalid ${field}`);
		return count;
	};
	const input = integer("inputTokens");
	const cached = integer("cachedInputTokens");
	return {
		inputTokens: Math.max(0, input - cached),
		outputTokens: integer("outputTokens"),
		cacheReadTokens: cached,
		reasoningTokens: integer("reasoningOutputTokens")
	};
}
/** Read the authoritative capacity reported with one App Server usage update. */
function contextWindowFromUsage(value) {
	const contextWindow = object(value, "token usage").modelContextWindow;
	if (contextWindow === void 0 || contextWindow === null) return void 0;
	if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error("codex-plugin-dsh: App Server returned invalid modelContextWindow");
	return contextWindow;
}
function availableDecisions(params) {
	if (!Array.isArray(params.availableDecisions)) return void 0;
	return new Set(params.availableDecisions.filter((value) => typeof value === "string"));
}
function deniedDecision(params, cancelled) {
	const available = availableDecisions(params);
	if (cancelled && (available === void 0 || available.has("cancel"))) return "cancel";
	if (available === void 0 || available.has("decline")) return "decline";
	if (available.has("cancel")) return "cancel";
	throw new Error("codex-plugin-dsh: App Server offered no fail-closed approval decision");
}
function catalogModel(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const raw = value;
	if (typeof raw.id !== "string" || raw.id.length === 0 || raw.hidden === true) return void 0;
	const efforts = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.flatMap((item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
		const effort = item;
		if (typeof effort.reasoningEffort !== "string" || effort.reasoningEffort.length === 0) return [];
		return [{
			id: effort.reasoningEffort,
			...typeof effort.description === "string" && effort.description.length > 0 ? { description: effort.description } : {}
		}];
	}) : [];
	const inputModalities = Array.isArray(raw.inputModalities) ? raw.inputModalities.filter((item) => item === "text" || item === "image") : ["text", "image"];
	return {
		id: raw.id,
		name: typeof raw.displayName === "string" && raw.displayName.length > 0 ? raw.displayName : raw.id,
		...typeof raw.description === "string" && raw.description.length > 0 ? { description: raw.description } : {},
		...typeof raw.defaultReasoningEffort === "string" && raw.defaultReasoningEffort.length > 0 ? { defaultReasoningEffort: raw.defaultReasoningEffort } : {},
		supportedReasoningEfforts: efforts,
		inputModalities
	};
}
/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
var CodexAppServerAdapter = class extends LlmAdapter {
	ctx;
	config;
	cachedModels;
	pendingModels;
	observedContextWindows = /* @__PURE__ */ new Map();
	activeTurns = /* @__PURE__ */ new Map();
	startingTurns = /* @__PURE__ */ new Map();
	/** Startup ownership exists before a turn is published into ownedTurns. */
	startingOwnedTurns = /* @__PURE__ */ new Set();
	disposingSessions = /* @__PURE__ */ new Set();
	disposed = false;
	disposeTask;
	lifecycleTail = Promise.resolve();
	managementFences = 0;
	threadCreationObserver;
	lastThreadPresentationError;
	appliedThreadSections = /* @__PURE__ */ new Map();
	/** Every owned process, including isolated auxiliary calls not keyed by session. */
	ownedTurns = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		super();
		this.ctx = ctx;
		this.config = config;
	}
	setThreadCreationObserver(observer) {
		this.threadCreationObserver = observer;
	}
	/** Last best-effort naming/grouping failure, excluded from model routing. */
	threadPresentationError() {
		return this.lastThreadPresentationError;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Codex App Server (local)"
		};
	}
	providerRetryPolicy(_provider) {
		return CODEX_RETRY_POLICY;
	}
	async listModels(provider) {
		return (await this.models()).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: model.inputModalities
		}));
	}
	async resolveModel(provider, modelId, signal) {
		const model = (await this.models(signal)).find((candidate) => candidate.id === modelId);
		const contextWindow = this.contextWindowFor(modelId);
		if (model === void 0) return {
			provider,
			id: modelId,
			name: modelId,
			...contextWindow === void 0 ? {} : { context: { contextWindow } }
		};
		return {
			provider,
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: model.inputModalities,
			...contextWindow === void 0 ? {} : { context: { contextWindow } },
			...model.supportedReasoningEfforts.length === 0 ? {} : { reasoning: {
				efforts: model.supportedReasoningEfforts.map((effort) => ({
					id: ReasoningEffortId(effort.id),
					name: effort.id,
					...effort.description === void 0 ? {} : { description: effort.description }
				})),
				...model.defaultReasoningEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) }
			} }
		};
	}
	contextWindowFor(modelId) {
		const observed = this.observedContextWindows.get(modelId);
		if (observed !== void 0) return observed;
		const configured = this.config.modelContextWindows?.[modelId] ?? this.config.contextWindowTokens ?? 0;
		return configured > 0 ? configured : void 0;
	}
	threadPresentationPolicy() {
		const sectionName = this.config.subagentSectionName?.trim() ?? "DSH 子代理";
		return {
			ephemeralOneShotSubagents: this.config.ephemeralOneShotSubagents !== false,
			syncThreadNames: this.config.syncThreadNames !== false,
			...sectionName.length === 0 ? {} : { subagentSectionName: sectionName }
		};
	}
	/**
	* Bind exact model metadata and dispatch to this adapter generation, matching
	* the DSH 0.1.1 prepared-call contract. Configuration is immutable for the
	* instance, and the returned stream closure never reselects another adapter.
	*/
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	async *stream(options) {
		if (options.provider !== "codex-app-server") throw new Error(`codex-plugin-dsh: unexpected provider ${JSON.stringify(options.provider)}`);
		const auxiliaryPurpose = options.purpose === "compaction" || options.purpose === "session-title";
		if (!auxiliaryPurpose && options.sessionId === void 0) throw new Error("codex-plugin-dsh: conversational App Server calls require a live DSH session");
		const unsupported = [
			options.temperature === void 0 ? void 0 : "temperature",
			options.maxTokens === void 0 || auxiliaryPurpose ? void 0 : "maxTokens",
			options.stop === void 0 ? void 0 : "stop"
		].filter((value) => value !== void 0);
		if (unsupported.length > 0) throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(", ")}`);
		const session = options.sessionId === void 0 ? void 0 : this.ctx.sessions.get(options.sessionId);
		if (options.sessionId !== void 0 && session === void 0) throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`);
		const cwd = session?.header.cwd ?? (auxiliaryPurpose ? process.cwd() : void 0);
		if (cwd === void 0) throw new Error("codex-plugin-dsh: the selected DSH session has no working directory");
		const sessionId = options.sessionId === void 0 ? `auxiliary:${options.purpose}` : String(options.sessionId);
		const presentation = auxiliaryPurpose || session === void 0 ? {
			kind: "main",
			ephemeral: true
		} : resolveThreadPresentation({
			header: session.header,
			events: session.events ?? []
		}, this.threadPresentationPolicy());
		const acquired = auxiliaryPurpose ? {
			active: await this.beginStartTurn(options, sessionId, cwd, false, presentation).promise,
			existing: false
		} : await this.acquireConversationalTurn(options, sessionId, cwd, presentation);
		const { active } = acquired;
		const requestSignal = stepSignal(active.signal, options.signal);
		if (acquired.existing) {
			requestSignal.throwIfAborted();
			active.deadline.touch();
			const pending = active.awaiting;
			if (pending === void 0) throw new Error("codex-plugin-dsh: an App Server turn is already active for this DSH session");
			if (active.resuming !== void 0) throw new Error("codex-plugin-dsh: another DSH tool continuation is already answering this pending App Server call");
			active.resuming = pending;
			let continuation;
			try {
				const resolveContinuationImageUrl = (attachment) => attachmentDataUrl(this.ctx.attachments, attachment, requestSignal);
				continuation = await codexDynamicToolResult(options.messages, pending.call.callId, resolveContinuationImageUrl);
				if (continuation.steerInput.length > 0) await active.connection.request("turn/steer", {
					threadId: active.threadId,
					expectedTurnId: active.turnId,
					input: continuation.steerInput
				}, requestSignal);
				pending.response.resolve(continuation.response);
				active.deadline.touch();
			} catch (error) {
				pending.response.reject(thrown(error));
				throw error;
			} finally {
				if (active.awaiting === pending) delete active.awaiting;
				if (active.resuming === pending) delete active.resuming;
			}
			active.blocks.clear();
			active.nextBlockIndex = 0;
			active.finalOutput = false;
		}
		let keepAlive = false;
		try {
			for (;;) {
				const event = await active.events.next(requestSignal);
				active.deadline.touch();
				if (event.kind === "dynamic-tool") {
					if (!active.retainForTools) throw new Error("codex-plugin-dsh: auxiliary App Server calls cannot invoke DSH tools");
					const { call } = event;
					if (call.threadId !== active.threadId || call.turnId !== active.turnId) continue;
					if (active.awaiting !== void 0) throw new Error("codex-plugin-dsh: App Server issued another dynamic tool call before DSH returned the first result");
					if ([...active.blocks.values()].some((block) => !block.ended)) throw new Error("codex-plugin-dsh: App Server requested a dynamic tool with an open agent message");
					const argumentsText = JSON.stringify(call.arguments);
					if (argumentsText === void 0) throw new Error(`codex-plugin-dsh: App Server returned invalid arguments for DSH tool ${JSON.stringify(call.tool)}`);
					const index = active.nextBlockIndex++;
					const id = CallId(call.callId);
					yield {
						type: "block-start",
						index,
						blockType: "tool-call"
					};
					yield {
						type: "tool-call-delta",
						index,
						id,
						name: call.tool,
						argumentsDelta: argumentsText
					};
					yield {
						type: "block-end",
						index,
						block: {
							type: "tool-call",
							id,
							name: call.tool,
							arguments: argumentsText
						}
					};
					active.awaiting = event;
					active.blocks.clear();
					active.nextBlockIndex = 0;
					active.finalOutput = false;
					keepAlive = true;
					yield {
						type: "finish",
						reason: { kind: "tool-calls" }
					};
					return;
				}
				const { method, params } = event.notification;
				if (params.threadId !== active.threadId) continue;
				if ((method === "turn/completed" ? object(params.turn, "turn/completed turn").id : params.turnId) !== active.turnId) continue;
				if (method === "item/started") {
					const item = object(params.item, "started item");
					if (item.type === "reasoning") {
						const itemId = string(item.id, "reasoning item id");
						const summary = reasoningSummaryText(item.summary, "reasoning item summary");
						for (const chunk of appendReasoningSummary(active, itemId, summary)) yield chunk;
						continue;
					}
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "agent message item id");
					if (active.blocks.has(itemId)) continue;
					const phase = phaseOf(item.phase);
					const block = {
						index: active.nextBlockIndex++,
						type: blockType(phase),
						phase,
						text: "",
						ended: false
					};
					active.blocks.set(itemId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: block.type
					};
					continue;
				}
				if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
					const itemId = string(params.itemId, "reasoning item id");
					if (typeof params.delta !== "string") throw new Error("codex-plugin-dsh: App Server returned invalid reasoning delta");
					for (const chunk of appendReasoningSummary(active, itemId, params.delta)) yield chunk;
					continue;
				}
				if (method === "item/reasoning/summaryPartAdded") continue;
				if (method === "item/agentMessage/delta") {
					const itemId = string(params.itemId, "agent message delta item id");
					let block = active.blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: active.nextBlockIndex++,
							type: "text",
							phase: null,
							text: "",
							ended: false
						};
						active.blocks.set(itemId, block);
						yield {
							type: "block-start",
							index: block.index,
							blockType: block.type
						};
					}
					if (block.ended) throw new Error("codex-plugin-dsh: App Server emitted a delta after item/completed");
					const delta = typeof params.delta === "string" ? params.delta : "";
					block.text += delta;
					if (block.type === "reasoning") yield {
						type: "reasoning-delta",
						index: block.index,
						text: delta
					};
					else yield {
						type: "text-delta",
						index: block.index,
						text: delta
					};
					continue;
				}
				if (method === "item/completed") {
					const item = object(params.item, "completed item");
					if (item.type === "imageGeneration") {
						const itemId = string(item.id, "image generation item id");
						if (active.completedImages.has(itemId)) continue;
						active.completedImages.add(itemId);
						const image = await generatedImageBlock(this.ctx.attachments, item);
						if (image === void 0) continue;
						const index = active.nextBlockIndex++;
						yield {
							type: "block-start",
							index,
							blockType: "image"
						};
						yield {
							type: "block-end",
							index,
							block: image
						};
						active.finalOutput = true;
						continue;
					}
					if (item.type === "reasoning") {
						const itemId = string(item.id, "completed reasoning item id");
						const summary = reasoningSummaryText(item.summary, "completed reasoning item summary");
						const emitted = active.blocks.get(itemId)?.text ?? "";
						if (!summary.startsWith(emitted)) throw new Error("codex-plugin-dsh: completed reasoning summary did not match its streamed deltas");
						for (const chunk of appendReasoningSummary(active, itemId, summary.slice(emitted.length))) yield chunk;
						const completed = active.blocks.get(itemId);
						if (completed !== void 0) {
							completed.ended = true;
							yield {
								type: "block-end",
								index: completed.index,
								block: {
									type: "reasoning",
									text: completed.text
								}
							};
						}
						continue;
					}
					if (item.type !== "agentMessage") continue;
					const itemId = string(item.id, "completed agent message item id");
					const phase = phaseOf(item.phase);
					let block = active.blocks.get(itemId);
					if (block === void 0) {
						block = {
							index: active.nextBlockIndex++,
							type: blockType(phase),
							phase,
							text: "",
							ended: false
						};
						active.blocks.set(itemId, block);
						yield {
							type: "block-start",
							index: block.index,
							blockType: block.type
						};
					}
					const completedText = typeof item.text === "string" ? item.text : "";
					if (!completedText.startsWith(block.text)) throw new Error("codex-plugin-dsh: completed agent message did not match its streamed deltas");
					const tail = completedText.slice(block.text.length);
					if (tail.length > 0) {
						if (block.type === "reasoning") yield {
							type: "reasoning-delta",
							index: block.index,
							text: tail
						};
						else yield {
							type: "text-delta",
							index: block.index,
							text: tail
						};
						block.text = completedText;
					}
					block.ended = true;
					if (block.type === "reasoning") yield {
						type: "block-end",
						index: block.index,
						block: {
							type: "reasoning",
							text: block.text
						}
					};
					else {
						yield {
							type: "block-end",
							index: block.index,
							block: {
								type: "text",
								text: block.text
							}
						};
						if (block.phase !== "commentary" && block.text.trim().length > 0) active.finalOutput = true;
					}
					continue;
				}
				if (method === "thread/tokenUsage/updated") {
					active.usage = usageFrom(params.tokenUsage);
					const contextWindow = contextWindowFromUsage(params.tokenUsage);
					if (contextWindow !== void 0) this.observedContextWindows.set(active.model, contextWindow);
					continue;
				}
				if (method === "error" && params.willRetry !== true) throw new LlmError(messageText(params.error), "CODEX_APP_SERVER");
				if (method !== "turn/completed") continue;
				const completedTurn = object(params.turn, "turn/completed turn");
				if (contextWindowExceeded(completedTurn)) throw new LlmError("Codex App Server rejected the request because the model context window was exceeded", CONTEXT_WINDOW_EXCEEDED_CODE);
				if (completedTurn.status !== "completed") throw turnFailure(completedTurn);
				if ([...active.blocks.values()].some((block) => !block.ended)) throw new Error("codex-plugin-dsh: App Server completed with an open agent message");
				if (!active.finalOutput) throw new Error("codex-plugin-dsh: App Server completed without a final answer or image");
				if (active.usage !== void 0) yield {
					type: "usage",
					usage: active.usage
				};
				yield {
					type: "finish",
					reason: { kind: "stop" },
					...active.persistentThread ? { replayState: { response: active.replayState } } : {}
				};
				return;
			}
		} finally {
			if (!keepAlive) await this.closeTurn(active);
		}
	}
	beginStartTurn(options, sessionId, cwd, retainForTools, presentation) {
		if (this.disposed) throw new Error("codex-plugin-dsh: adapter is disposed");
		if (this.managementFences > 0) throw new Error("codex-plugin-dsh: explicit thread lifecycle management is in progress");
		if (this.disposingSessions.has(sessionId)) throw new Error(`codex-plugin-dsh: session ${JSON.stringify(sessionId)} is being disposed`);
		const controller = new AbortController();
		const promise = this.enqueueLifecycle(() => this.startTurn(options, sessionId, cwd, retainForTools, presentation, controller.signal));
		const starting = {
			sessionId,
			controller,
			promise
		};
		this.startingOwnedTurns.add(starting);
		promise.finally(() => this.startingOwnedTurns.delete(starting)).catch(() => {});
		return starting;
	}
	async acquireConversationalTurn(options, sessionId, cwd, presentation) {
		if (this.disposed) throw new Error("codex-plugin-dsh: adapter is disposed");
		if (this.disposingSessions.has(sessionId)) throw new Error(`codex-plugin-dsh: session ${JSON.stringify(sessionId)} is being disposed`);
		const current = this.activeTurns.get(sessionId);
		if (current !== void 0) return {
			active: current,
			existing: true
		};
		const starting = this.startingTurns.get(sessionId);
		if (starting !== void 0) return {
			active: await starting.promise,
			existing: true
		};
		const created = this.beginStartTurn(options, sessionId, cwd, true, presentation);
		this.startingTurns.set(sessionId, created);
		try {
			return {
				active: await created.promise,
				existing: false
			};
		} finally {
			if (this.startingTurns.get(sessionId) === created) this.startingTurns.delete(sessionId);
		}
	}
	async startTurn(options, sessionId, cwd, retainForTools, presentation, ownerSignal) {
		const deadline = new TurnIdleDeadline(this.config.turnTimeoutMs);
		const turnSignal = deadline.signal;
		const setupSignal = stepSignal(turnSignal, ownerSignal === void 0 ? options.signal : options.signal === void 0 ? ownerSignal : AbortSignal.any([options.signal, ownerSignal]));
		const imageUrls = /* @__PURE__ */ new Map();
		const resolveImageUrl = (attachment) => {
			const key = String(attachment.attachmentId);
			const existing = imageUrls.get(key);
			if (existing !== void 0) return existing;
			const pending = attachmentDataUrl(this.ctx.attachments, attachment, setupSignal);
			imageUrls.set(key, pending);
			return pending;
		};
		const turnTools = retainForTools ? options.tools : void 0;
		let history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, !retainForTools || presentation.ephemeral, sessionId);
		const toolSignature = codexToolSignature(turnTools);
		if (history.checkpoint !== void 0 && history.checkpoint.toolSignature !== toolSignature) history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, true, sessionId);
		const availableTools = new Set((turnTools ?? []).map((tool) => tool.name));
		const events = new ActiveTurnQueue();
		let threadId;
		let turnId;
		let connection;
		const observer = {
			notification: (notification) => {
				deadline.touch();
				events.push({
					kind: "notification",
					notification
				});
			},
			failure: (error) => {
				events.fail(error);
			}
		};
		const liveAgent = !retainForTools || options.sessionId === void 0 ? void 0 : this.ctx.agents.get(options.sessionId);
		try {
			connection = await this.openConnection(cwd, setupSignal, (method, params) => {
				deadline.touch();
				const releaseDeadline = deadline.hold();
				if (method !== "item/tool/call") {
					const response = this.handleServerRequest(method, params, liveAgent, turnSignal);
					response.then(releaseDeadline, releaseDeadline);
					return response;
				}
				if (!retainForTools) {
					releaseDeadline();
					return Promise.reject(/* @__PURE__ */ new Error("codex-plugin-dsh: auxiliary App Server calls cannot invoke DSH tools"));
				}
				const response = Promise.withResolvers();
				response.promise.then(releaseDeadline, releaseDeadline);
				try {
					events.push({
						kind: "dynamic-tool",
						call: codexDynamicToolCall(params, availableTools),
						response
					});
				} catch (error) {
					response.reject(thrown(error));
				}
				return response.promise;
			}, observer, turnSignal);
			await connection.initialize(setupSignal);
			const isolationConfig = await this.isolationConfig(connection, setupSignal);
			const dynamicTools = !retainForTools || history.checkpoint?.toolSignature === toolSignature ? void 0 : codexDynamicTools(turnTools);
			if (history.checkpoint === void 0) {
				threadId = threadResponse(await connection.request("thread/start", this.threadParams(options, cwd, isolationConfig, presentation.ephemeral, dynamicTools ?? []), setupSignal), "thread/start").id;
				if (retainForTools && !presentation.ephemeral) await this.threadCreationObserver?.recordCreated({
					sessionId,
					threadId,
					kind: "start"
				});
			} else try {
				const read = threadResponse(await connection.request("thread/read", {
					threadId: history.checkpoint.threadId,
					includeTurns: true
				}, setupSignal), "thread/read", true);
				if (decideThreadContinuation(history.checkpoint.turnId, {
					threadId: read.id,
					...read.headTurnId === void 0 ? {} : { headTurnId: read.headTurnId },
					...read.headTurnStatus === void 0 ? {} : { headTurnStatus: read.headTurnStatus }
				}) === "resume") threadId = threadResponse(await connection.request("thread/resume", {
					...this.resumeThreadParams(options, cwd, isolationConfig),
					threadId: history.checkpoint.threadId
				}, setupSignal), "thread/resume").id;
				else {
					threadId = threadResponse(await connection.request("thread/fork", {
						...this.threadParams(options, cwd, isolationConfig, presentation.ephemeral),
						threadId: history.checkpoint.threadId,
						lastTurnId: history.checkpoint.turnId
					}, setupSignal), "thread/fork").id;
					if (!presentation.ephemeral) await this.threadCreationObserver?.recordCreated({
						sessionId,
						threadId,
						kind: "fork",
						parentThreadId: history.checkpoint.threadId
					});
				}
			} catch (error) {
				if (!missingThread(error)) throw error;
				history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, true, sessionId);
				threadId = threadResponse(await connection.request("thread/start", this.threadParams(options, cwd, isolationConfig, presentation.ephemeral, codexDynamicTools(turnTools)), setupSignal), "thread/start").id;
				if (!presentation.ephemeral) await this.threadCreationObserver?.recordCreated({
					sessionId,
					threadId,
					kind: "start"
				});
			}
			await this.applyThreadPresentation(connection, threadId, presentation, setupSignal);
			if (history.injectItems.length > 0) await connection.request("thread/inject_items", {
				threadId,
				items: history.injectItems
			}, setupSignal);
			turnId = string(object((await connection.request("turn/start", {
				threadId,
				input: history.turnInput,
				model: options.model,
				summary: "concise",
				...options.reasoningEffort === void 0 ? {} : { effort: options.reasoningEffort }
			}, setupSignal)).turn, "turn/start turn").id, "turn id");
			let active;
			active = {
				sessionId,
				model: options.model,
				toolSignature,
				connection,
				events,
				deadline,
				signal: turnSignal,
				threadId,
				turnId,
				replayState: {
					kind: "codex-app-server",
					version: 1,
					threadId,
					turnId,
					sessionId,
					toolSignature
				},
				retainForTools,
				persistentThread: !presentation.ephemeral,
				...options.purpose === void 0 ? {} : { purpose: options.purpose },
				onAbort: () => {
					connection?.interrupt(threadId, turnId);
					this.closeTurn(active);
				},
				blocks: /* @__PURE__ */ new Map(),
				completedImages: /* @__PURE__ */ new Set(),
				nextBlockIndex: 0,
				finalOutput: false
			};
			turnSignal.addEventListener("abort", active.onAbort, { once: true });
			this.ownedTurns.add(active);
			if (retainForTools) this.activeTurns.set(active.sessionId, active);
			return active;
		} catch (error) {
			deadline.dispose();
			events.fail(thrown(error));
			await connection?.close();
			throw error;
		}
	}
	async closeTurn(active, reason) {
		if (active.closing !== void 0) return active.closing;
		const closing = this.finishCloseTurn(active, reason);
		active.closing = closing;
		return closing;
	}
	async finishCloseTurn(active, reason) {
		if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId);
		this.ownedTurns.delete(active);
		active.signal.removeEventListener("abort", active.onAbort);
		active.deadline.dispose();
		const closed = reason ?? (active.signal.aborted ? abortError(active.signal) : /* @__PURE__ */ new Error("codex-plugin-dsh: App Server turn closed before a pending DSH tool result was returned"));
		active.awaiting?.response.reject(closed);
		active.events.fail(closed);
		await active.connection.close();
	}
	hasActiveSession(sessionId) {
		return this.activeTurns.has(sessionId) || this.startingTurns.has(sessionId) || [...this.startingOwnedTurns].some((starting) => starting.sessionId === sessionId);
	}
	/** Reject new startup while serializing one explicit lifecycle mutation. */
	async withLifecycleFence(operation) {
		this.managementFences += 1;
		try {
			return await this.enqueueLifecycle(operation);
		} finally {
			this.managementFences = Math.max(0, this.managementFences - 1);
		}
	}
	async enqueueLifecycle(operation) {
		const prior = this.lifecycleTail;
		const gate = Promise.withResolvers();
		const tail = prior.then(() => gate.promise);
		this.lifecycleTail = tail;
		await prior;
		try {
			return await operation();
		} finally {
			gate.resolve();
			if (this.lifecycleTail === tail) this.lifecycleTail = Promise.resolve();
		}
	}
	async isThreadActive(threadId, parentSignal) {
		if ([...this.activeTurns.values()].some((turn) => turn.threadId === threadId)) return true;
		if (threadId.length === 0) throw new Error("codex-plugin-dsh: threadId must be non-empty");
		const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs);
		const connection = await this.openConnection(process.cwd(), signal, (requestMethod) => Promise.reject(/* @__PURE__ */ new Error(`codex-plugin-dsh: unexpected App Server request during thread/read: ${requestMethod}`)));
		try {
			await connection.initialize(signal);
			return threadResponse(await connection.request("thread/read", {
				threadId,
				includeTurns: true
			}, signal), "thread/read", true).headTurnStatus === "inProgress";
		} catch (error) {
			if (missingThread(error)) return false;
			throw error;
		} finally {
			await connection.close();
		}
	}
	async archiveThread(threadId, parentSignal) {
		await this.manageThread("thread/archive", threadId, parentSignal);
	}
	async unarchiveThread(threadId, parentSignal) {
		await this.manageThread("thread/unarchive", threadId, parentSignal);
	}
	async deleteThread(threadId, parentSignal) {
		await this.manageThread("thread/delete", threadId, parentSignal);
	}
	async manageThread(method, threadId, parentSignal) {
		if (threadId.length === 0) throw new Error("codex-plugin-dsh: threadId must be non-empty");
		const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs);
		const connection = await this.openConnection(process.cwd(), signal, (requestMethod) => Promise.reject(/* @__PURE__ */ new Error(`codex-plugin-dsh: unexpected App Server request during ${method}: ${requestMethod}`)));
		try {
			await connection.initialize(signal);
			await connection.request(method, { threadId }, signal);
		} catch (error) {
			if (method !== "thread/delete" || !missingThread(error)) throw error;
		} finally {
			await connection.close();
		}
	}
	/** Apply non-semantic sidebar presentation without touching DSH conversation state. */
	async applyThreadPresentation(connection, threadId, presentation, signal) {
		if (presentation.ephemeral) return;
		try {
			if (presentation.name !== void 0) await connection.request("thread/name/set", {
				threadId,
				name: presentation.name
			}, signal);
			if (presentation.sectionName === void 0 || this.appliedThreadSections.get(threadId) === presentation.sectionName) return;
			const sectionId = await this.ensureThreadSection(connection, presentation.sectionName, signal);
			await connection.request("thread/section/move", {
				threadId,
				sectionId,
				beforeThreadId: null
			}, signal);
			this.appliedThreadSections.set(threadId, presentation.sectionName);
		} catch (error) {
			this.lastThreadPresentationError = thrown(error).message;
		}
	}
	/** Reuse one exact custom section name, creating it once when absent. */
	async ensureThreadSection(connection, sectionName, signal) {
		let cursor = null;
		const seen = /* @__PURE__ */ new Set();
		for (;;) {
			const response = object(await connection.request("threadSection/list", {
				cursor,
				limit: 100
			}, signal), "threadSection/list response");
			if (!Array.isArray(response.data)) throw new Error("codex-plugin-dsh: App Server returned invalid threadSection/list data");
			for (const raw of response.data) {
				const section = object(raw, "thread section");
				if (section.name === sectionName) return string(section.id, "thread section id");
			}
			if (response.nextCursor === null) break;
			const nextCursor = string(response.nextCursor, "thread section cursor");
			if (seen.has(nextCursor)) throw new Error("codex-plugin-dsh: App Server repeated a thread section cursor");
			seen.add(nextCursor);
			cursor = nextCursor;
		}
		return string(object(object(await connection.request("threadSection/create", {
			name: sectionName,
			appearance: null
		}, signal), "threadSection/create response").section, "created thread section").id, "created thread section id");
	}
	/** Close every startup or turn owned by one DSH session. */
	async disposeSession(sessionId) {
		const reason = /* @__PURE__ */ new Error("codex-plugin-dsh: owning DSH session was disposed");
		this.disposingSessions.add(sessionId);
		try {
			const starting = [...this.startingOwnedTurns].filter((item) => item.sessionId === sessionId);
			for (const item of starting) item.controller.abort(reason);
			await Promise.allSettled(starting.map((item) => item.promise));
			await Promise.all([...this.ownedTurns].filter((active) => active.sessionId === sessionId).map((active) => this.closeTurn(active, reason)));
		} finally {
			this.disposingSessions.delete(sessionId);
		}
	}
	/** Dispose every App Server startup and process owned by this adapter. */
	async dispose() {
		if (this.disposeTask !== void 0) return this.disposeTask;
		this.disposed = true;
		const task = (async () => {
			const reason = /* @__PURE__ */ new Error("codex-plugin-dsh: plugin was disposed");
			const starting = [...this.startingOwnedTurns];
			for (const item of starting) item.controller.abort(reason);
			await Promise.allSettled(starting.map((item) => item.promise));
			await Promise.all([...this.ownedTurns].map((active) => this.closeTurn(active, reason)));
		})();
		this.disposeTask = task;
		return task;
	}
	resumeThreadParams(options, cwd, isolationConfig) {
		return {
			cwd,
			model: options.model,
			approvalPolicy: "never",
			sandbox: "read-only",
			config: isolationConfig,
			...options.system === void 0 ? {} : { baseInstructions: options.system },
			developerInstructions: CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS
		};
	}
	threadParams(options, cwd, isolationConfig, ephemeral, dynamicTools) {
		return {
			...this.resumeThreadParams(options, cwd, isolationConfig),
			ephemeral,
			...dynamicTools === void 0 ? {} : { dynamicTools }
		};
	}
	async isolationConfig(connection, signal) {
		const current = recordValue((await connection.request("config/read", { includeLayers: false }, signal)).config);
		const disabledMcpServers = Object.fromEntries(Object.keys(recordValue(current.mcp_servers)).map((name) => [name, { enabled: false }]));
		return {
			features: {
				shell_tool: false,
				unified_exec: false,
				multi_agent: false,
				plugins: false
			},
			agents: { enabled: false },
			web_search: "disabled",
			tools: { view_image: false },
			apps: {
				_default: { enabled: false },
				...Object.fromEntries(Object.keys(recordValue(current.apps)).filter((name) => name !== "_default").map((name) => [name, { enabled: false }]))
			},
			mcp_servers: disabledMcpServers
		};
	}
	async models(parentSignal) {
		if (this.cachedModels !== void 0 && this.cachedModels.expiresAt > Date.now()) return this.cachedModels.models;
		if (this.pendingModels !== void 0) return this.pendingModels;
		const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs);
		const pending = this.loadModels(signal);
		this.pendingModels = pending;
		try {
			const models = await pending;
			this.cachedModels = {
				expiresAt: Date.now() + this.config.modelCacheMs,
				models
			};
			return models;
		} finally {
			if (this.pendingModels === pending) this.pendingModels = void 0;
		}
	}
	async loadModels(signal) {
		const connection = await this.openConnection(process.cwd(), signal, (method) => Promise.reject(/* @__PURE__ */ new Error(`codex-plugin-dsh: unexpected App Server request during model discovery: ${method}`)));
		try {
			await connection.initialize(signal);
			const accountResult = await connection.request("account/read", { refreshToken: false }, signal);
			if (accountResult.requiresOpenaiAuth === true && accountResult.account == null) throw new LlmError("Codex login is required; run `codex login` on the DSH host", "AUTH");
			const models = [];
			let cursor = null;
			do {
				const result = await connection.request("model/list", {
					cursor,
					includeHidden: false,
					limit: this.config.modelPageSize
				}, signal);
				if (!Array.isArray(result.data)) throw new Error("codex-plugin-dsh: App Server returned invalid model list");
				models.push(...result.data.flatMap((value) => {
					const parsed = catalogModel(value);
					return parsed === void 0 ? [] : [parsed];
				}));
				cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
			} while (cursor !== null);
			if (models.length === 0) throw new Error("codex-plugin-dsh: App Server returned no available models");
			return models;
		} finally {
			await connection.close();
		}
	}
	async openConnection(cwd, signal, requestHandler, observer, lifetimeSignal = signal) {
		const executable = await this.ctx.subprocess.resolveExecutable(this.config.executable, this.config.env, signal);
		const commandInterpreter = process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase()) ? await this.ctx.subprocess.resolveExecutable("cmd.exe", this.config.env, signal) : void 0;
		const invocation = codexAppServerInvocation(executable, this.config.env, process.platform, commandInterpreter);
		return new CodexAppServerConnection(this.ctx.subprocess.spawn({
			argv: [...invocation.argv],
			cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: { maxBytes: this.config.stderrMaxBytes }
			},
			graceMs: this.config.disposeGraceMs,
			env: invocation.env,
			signal: lifetimeSignal
		}), requestHandler, observer, Math.max(5e3, this.config.disposeGraceMs * 2));
	}
	async handleServerRequest(method, params, agent, signal) {
		switch (method) {
			case "item/commandExecution/requestApproval":
			case "item/fileChange/requestApproval": return { decision: deniedDecision(params, false) };
			case "item/permissions/requestApproval": return {
				permissions: {},
				scope: "turn"
			};
			case "mcpServer/elicitation/request": return {
				action: "decline",
				content: null,
				_meta: null
			};
			case "item/tool/requestUserInput": return this.bridgeUserInput(params, agent, signal);
			default: throw new Error(`codex-plugin-dsh: unsupported App Server request ${JSON.stringify(method)}`);
		}
	}
	/**
	* Bridge an App Server `item/tool/requestUserInput` request to the DSH
	* user-questions UI, then answer the pending JSON-RPC request with the
	* human's selection. Questions are mapped to the DSH ask format; secret
	* questions and agentless calls fail explicitly instead of being shown
	* unmasked or guessed.
	*/
	async bridgeUserInput(params, agent, signal) {
		const request = object(params, "item/tool/requestUserInput params");
		if (!Array.isArray(request.questions)) throw new Error("codex-plugin-dsh: App Server requested user input without a questions array");
		if (agent === void 0) throw new Error("codex-plugin-dsh: App Server requested interactive user input, but no live DSH agent session is available to answer");
		const questions = [];
		for (const raw of request.questions) {
			const question = object(raw, "requestUserInput question");
			const id = string(question.id, "requestUserInput question id");
			if (question.isSecret === true) throw new Error("codex-plugin-dsh: App Server requested secret user input, which the DSH question bridge refuses to show unmasked");
			const text = string(question.question, "requestUserInput question text");
			const header = typeof question.header === "string" && question.header.length > 0 ? question.header : void 0;
			const options = Array.isArray(question.options) ? question.options.map((value) => {
				const option = object(value, "requestUserInput option");
				const label = string(option.label, "requestUserInput option label");
				const description = typeof option.description === "string" ? option.description : void 0;
				return description === void 0 ? { label } : {
					label,
					description
				};
			}) : void 0;
			questions.push({
				id,
				question: text,
				...header === void 0 ? {} : { header },
				...options === void 0 ? {} : { options },
				multiSelect: false
			});
		}
		const answer = await this.ctx.userQuestions.ask({
			questions,
			agent,
			signal
		});
		const answers = {};
		for (const item of answer.answers) {
			const selected = [...item.selected];
			if (item.custom !== void 0) selected.push(item.custom);
			if (selected.length > 0) answers[item.id] = { answers: selected };
		}
		return { answers };
	}
};
//#endregion
//#region src/registry.ts
/** Durable, rebuildable DSH Session to Codex Thread reference index. */
const CODEX_THREAD_REGISTRY_SERVICE = "codexThreadRegistry";
const REGISTRY_VERSION = 1;
function defaultCodexThreadRegistryPath() {
	const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(dshHome, "codex-plugin-dsh", "thread-registry.json");
}
function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function parseRegistry(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("codex-plugin-dsh: thread registry root must be an object");
	const root = value;
	if (root.version !== REGISTRY_VERSION || !Array.isArray(root.receipts) || !Array.isArray(root.sessions)) throw new Error("codex-plugin-dsh: unsupported or malformed thread registry");
	const receipts = root.receipts.map((raw) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("codex-plugin-dsh: invalid thread creation receipt");
		const item = raw;
		const threadId = optionalString(item.threadId);
		const sessionId = optionalString(item.sessionId);
		if (threadId === void 0 || sessionId === void 0 || item.kind !== "start" && item.kind !== "fork") throw new Error("codex-plugin-dsh: invalid thread creation receipt");
		const parentThreadId = optionalString(item.parentThreadId);
		return {
			threadId,
			sessionId,
			kind: item.kind,
			...parentThreadId === void 0 ? {} : { parentThreadId },
			createdAt: typeof item.createdAt === "number" && Number.isSafeInteger(item.createdAt) ? item.createdAt : 0,
			deleted: item.deleted === true
		};
	});
	if (root.intents !== void 0 && !Array.isArray(root.intents)) throw new Error("codex-plugin-dsh: invalid thread management intents");
	const intents = (root.intents ?? []).map((raw) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("codex-plugin-dsh: invalid thread management intent");
		const item = raw;
		const operationId = optionalString(item.operationId);
		const threadId = optionalString(item.threadId);
		if (operationId === void 0 || threadId === void 0 || item.action !== "archive" && item.action !== "unarchive" && item.action !== "delete") throw new Error("codex-plugin-dsh: invalid thread management intent");
		const sessionId = optionalString(item.sessionId);
		return {
			operationId,
			threadId,
			action: item.action,
			...sessionId === void 0 ? {} : { sessionId },
			createdAt: typeof item.createdAt === "number" && Number.isSafeInteger(item.createdAt) ? item.createdAt : 0
		};
	});
	const sessions = root.sessions.map((raw) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("codex-plugin-dsh: invalid thread binding");
		const item = raw;
		const sessionId = optionalString(item.sessionId);
		if (sessionId === void 0 || !Array.isArray(item.refs)) throw new Error("codex-plugin-dsh: invalid thread binding");
		const refs = item.refs.map((rawRef) => {
			if (rawRef === null || typeof rawRef !== "object" || Array.isArray(rawRef)) throw new Error("codex-plugin-dsh: invalid thread reference");
			const ref = rawRef;
			const threadId = optionalString(ref.threadId);
			if (threadId === void 0 || ref.role !== "canonical" && ref.role !== "branch" && ref.role !== "pending" || ref.externalState !== "live" && ref.externalState !== "archived" && ref.externalState !== "deleted" && ref.externalState !== "unknown") throw new Error("codex-plugin-dsh: invalid thread reference");
			const committedTurnId = optionalString(ref.committedTurnId);
			return {
				threadId,
				role: ref.role,
				externalState: ref.externalState,
				...committedTurnId === void 0 ? {} : { committedTurnId },
				...typeof ref.eventSeq === "number" && Number.isSafeInteger(ref.eventSeq) && ref.eventSeq >= 0 ? { eventSeq: ref.eventSeq } : {}
			};
		});
		const workspace = optionalString(item.workspace);
		return {
			sessionId,
			...workspace === void 0 ? {} : { workspace },
			released: item.released === true,
			refs
		};
	});
	return {
		version: REGISTRY_VERSION,
		updatedAt: typeof root.updatedAt === "number" && Number.isSafeInteger(root.updatedAt) ? root.updatedAt : 0,
		receipts,
		intents,
		sessions
	};
}
function replayStateFromEvent(event) {
	if (event.type !== "assistant/message") return void 0;
	const source = event.data.message?.source;
	if (source?.kind !== "model" || source.provider !== "codex-app-server") return void 0;
	return codexReplayState(source.replayState);
}
/**
* Registry sidecar. DSH session logs remain authoritative; this file is only a
* rebuildable reference/ownership index and never authorizes a destructive action
* without an owned creation receipt and a fresh reference-count check.
*/
var CodexThreadRegistry = class {
	ctx;
	driver;
	bindings = /* @__PURE__ */ new Map();
	receipts = /* @__PURE__ */ new Map();
	intents = /* @__PURE__ */ new Map();
	stateTail = Promise.resolve();
	storageHealthy = true;
	lastError;
	writeTail = Promise.resolve();
	reconcileTask;
	operationTails = /* @__PURE__ */ new Map();
	constructor(ctx, driver, storagePath = defaultCodexThreadRegistryPath()) {
		this.ctx = ctx;
		this.driver = driver;
		this.storagePath = storagePath === ":memory:" ? storagePath : resolve(storagePath);
	}
	storagePath;
	async initialize() {
		if (this.storagePath === ":memory:") return;
		try {
			const text = await readFile(this.storagePath, "utf8");
			this.restore(parseRegistry(JSON.parse(text)));
		} catch (error) {
			if (error.code === "ENOENT") return;
			this.storageHealthy = false;
			this.lastError = thrown(error).message;
		}
	}
	async recordCreated(creation) {
		await this.withStateLock(async () => {
			const receipt = {
				threadId: creation.threadId,
				sessionId: creation.sessionId,
				kind: creation.kind,
				...creation.parentThreadId === void 0 ? {} : { parentThreadId: creation.parentThreadId },
				createdAt: creation.createdAt ?? Date.now(),
				deleted: false
			};
			this.receipts.set(receipt.threadId, receipt);
			const binding = this.binding(creation.sessionId);
			if (!binding.refs.has(creation.threadId)) binding.refs.set(creation.threadId, {
				threadId: creation.threadId,
				role: "pending",
				externalState: "live"
			});
			await this.persist();
		});
	}
	async observeSessionEvent(session, event) {
		const state = replayStateFromEvent(event);
		if (state === void 0) return;
		await this.withStateLock(async () => {
			this.observeCheckpoint(String(session.id), session.header.cwd, event.seq, state);
			await this.persist();
		});
	}
	snapshot() {
		return {
			version: REGISTRY_VERSION,
			storagePath: this.storagePath,
			storageHealthy: this.storageHealthy,
			...this.lastError === void 0 ? {} : { lastError: this.lastError },
			pendingManagement: [...this.intents.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)).map((intent) => ({ ...intent })),
			sessions: [...this.bindings.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)).map((binding) => this.bindingSnapshot(binding))
		};
	}
	refsForSession(sessionId) {
		const binding = this.bindings.get(sessionId);
		return binding === void 0 ? [] : this.bindingSnapshot(binding).refs;
	}
	referenceCount(threadId) {
		let count = 0;
		for (const binding of this.bindings.values()) if (!binding.released && binding.refs.has(threadId)) count += 1;
		return count;
	}
	reconcile(signal) {
		if (this.reconcileTask !== void 0) return this.reconcileTask;
		const task = this.withStateLock(() => this.runReconcile(signal));
		this.reconcileTask = task;
		task.finally(() => {
			if (this.reconcileTask === task) this.reconcileTask = void 0;
		}).catch(() => {});
		return task;
	}
	async archiveSessionThreads(sessionId, operationId, signal) {
		return this.withOperation(`session:${sessionId}`, operationId, () => this.driver.withLifecycleFence(() => this.withStateLock(async () => {
			this.assertManagementHealthy();
			if (this.driver.hasActiveSession(sessionId)) throw new Error("codex-plugin-dsh: cannot archive Codex threads while the DSH session has an active App Server turn");
			const binding = this.bindings.get(sessionId);
			if (binding === void 0) return [];
			if (binding.released) return [...binding.refs.values()].map((ref) => ({
				threadId: ref.threadId,
				action: "skipped",
				reason: "session binding is released"
			}));
			const decisions = [];
			for (const ref of binding.refs.values()) {
				const reason = this.lifecycleBlockReason(ref.threadId);
				if (reason !== void 0) {
					decisions.push({
						threadId: ref.threadId,
						action: "skipped",
						reason
					});
					continue;
				}
				if (ref.externalState === "archived") {
					decisions.push({
						threadId: ref.threadId,
						action: "skipped",
						reason: "already archived"
					});
					continue;
				}
				if (await this.driver.isThreadActive(ref.threadId, signal)) {
					decisions.push({
						threadId: ref.threadId,
						action: "skipped",
						reason: "thread has an active App Server turn"
					});
					continue;
				}
				await this.performManagementIntent({
					operationId,
					threadId: ref.threadId,
					action: "archive",
					sessionId,
					createdAt: Date.now()
				}, () => this.driver.archiveThread(ref.threadId, signal), () => {
					ref.externalState = "archived";
				});
				decisions.push({
					threadId: ref.threadId,
					action: "archived"
				});
			}
			await this.persist();
			return decisions;
		})));
	}
	async restoreSessionThreads(sessionId, operationId, signal) {
		return this.withOperation(`session:${sessionId}`, operationId, () => this.driver.withLifecycleFence(() => this.withStateLock(async () => {
			this.assertManagementHealthy();
			const binding = this.bindings.get(sessionId);
			if (binding === void 0) return [];
			const decisions = [];
			for (const ref of binding.refs.values()) {
				const receipt = this.receipts.get(ref.threadId);
				if (receipt === void 0 || receipt.deleted) {
					decisions.push({
						threadId: ref.threadId,
						action: "skipped",
						reason: "thread ownership is not proven"
					});
					continue;
				}
				if (ref.externalState !== "archived") {
					decisions.push({
						threadId: ref.threadId,
						action: "skipped",
						reason: "thread was not archived by this registry"
					});
					continue;
				}
				await this.performManagementIntent({
					operationId,
					threadId: ref.threadId,
					action: "unarchive",
					sessionId,
					createdAt: Date.now()
				}, () => this.driver.unarchiveThread(ref.threadId, signal), () => {
					ref.externalState = "live";
				});
				decisions.push({
					threadId: ref.threadId,
					action: "unarchived"
				});
			}
			binding.released = false;
			await this.persist();
			return decisions;
		})));
	}
	async releaseSession(sessionId, operationId) {
		await this.withOperation(`session:${sessionId}`, operationId, () => this.driver.withLifecycleFence(() => this.withStateLock(async () => {
			this.assertManagementHealthy();
			const binding = this.bindings.get(sessionId);
			if (binding === void 0) return;
			if (this.driver.hasActiveSession(sessionId)) throw new Error("codex-plugin-dsh: cannot release references for an active DSH session");
			binding.released = true;
			await this.persist();
		})));
	}
	async purgeUnreferencedThreads(threadIds, operationId, confirmed, signal) {
		if (!confirmed) throw new Error("codex-plugin-dsh: explicit purge confirmation is required");
		this.assertManagementHealthy();
		const decisions = [];
		for (const threadId of [...new Set(threadIds)]) {
			const result = await this.withOperation(`thread:${threadId}`, operationId, () => this.driver.withLifecycleFence(() => this.withStateLock(async () => {
				this.assertManagementHealthy();
				const reason = this.lifecycleBlockReason(threadId, true);
				if (reason !== void 0) return {
					threadId,
					action: "skipped",
					reason
				};
				if (await this.driver.isThreadActive(threadId, signal)) return {
					threadId,
					action: "skipped",
					reason: "thread has an active App Server turn"
				};
				await this.performManagementIntent({
					operationId,
					threadId,
					action: "delete",
					createdAt: Date.now()
				}, () => this.driver.deleteThread(threadId, signal), () => {
					const receipt = this.receipts.get(threadId);
					if (receipt !== void 0) receipt.deleted = true;
					for (const binding of this.bindings.values()) {
						const ref = binding.refs.get(threadId);
						if (ref !== void 0) ref.externalState = "deleted";
					}
				});
				return {
					threadId,
					action: "deleted"
				};
			})));
			decisions.push(result);
		}
		return decisions;
	}
	async dispose() {
		await this.stateTail;
		await this.writeTail;
	}
	async runReconcile(signal) {
		signal?.throwIfAborted();
		const headers = await this.ctx.sessionPersistence.list(signal);
		const materialized = new Set(headers.map((header) => String(header.id)));
		for (const header of headers) {
			signal?.throwIfAborted();
			const inspection = await this.ctx.sessionPersistence.inspect(header.id, signal);
			const sessionId = String(inspection.meta.id);
			const binding = this.binding(sessionId, inspection.meta.cwd);
			const previousRelease = binding.released;
			const previousRefs = new Map(binding.refs);
			binding.refs.clear();
			binding.released = previousRelease;
			for (const [threadId, ref] of previousRefs) if (ref.role === "pending" && this.receipts.get(threadId)?.deleted !== true) binding.refs.set(threadId, { ...ref });
			for (const event of inspection.events) {
				const state = replayStateFromEvent(event);
				if (state === void 0) continue;
				this.observeCheckpoint(sessionId, inspection.meta.cwd, event.seq, state);
				const ref = binding.refs.get(state.threadId);
				const previous = previousRefs.get(state.threadId);
				if (ref !== void 0) ref.externalState = previous?.externalState ?? (this.receipts.get(state.threadId)?.deleted === false ? "live" : "unknown");
			}
		}
		for (const binding of this.bindings.values()) if (!materialized.has(binding.sessionId) && !binding.released) {
			for (const ref of binding.refs.values()) if (ref.role !== "pending") ref.externalState = ref.externalState === "deleted" ? "deleted" : "unknown";
		}
		await this.persist();
		return this.snapshot();
	}
	observeCheckpoint(sessionId, workspace, eventSeq, state) {
		const binding = this.binding(sessionId, workspace);
		for (const ref of binding.refs.values()) if (ref.role === "canonical") ref.role = "branch";
		const existing = binding.refs.get(state.threadId);
		binding.refs.set(state.threadId, {
			threadId: state.threadId,
			role: state.sessionId === sessionId ? "canonical" : existing?.role === "pending" ? "pending" : "branch",
			committedTurnId: state.turnId,
			eventSeq,
			externalState: existing?.externalState ?? "unknown"
		});
	}
	binding(sessionId, workspace) {
		let binding = this.bindings.get(sessionId);
		if (binding === void 0) {
			binding = {
				sessionId,
				...workspace === void 0 ? {} : { workspace },
				released: false,
				refs: /* @__PURE__ */ new Map()
			};
			this.bindings.set(sessionId, binding);
		} else if (workspace !== void 0) binding.workspace = workspace;
		return binding;
	}
	bindingSnapshot(binding) {
		const refs = [...binding.refs.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)).map((ref) => {
			const receipt = this.receipts.get(ref.threadId);
			return {
				threadId: ref.threadId,
				role: ref.role,
				...ref.committedTurnId === void 0 ? {} : { committedTurnId: ref.committedTurnId },
				...ref.eventSeq === void 0 ? {} : { eventSeq: ref.eventSeq },
				ownedByPlugin: receipt !== void 0 && !receipt.deleted,
				active: this.driver.hasActiveSession(binding.sessionId),
				referenceCount: this.referenceCount(ref.threadId),
				externalState: ref.externalState,
				...receipt === void 0 ? {} : {
					createdBy: receipt.kind,
					...receipt.parentThreadId === void 0 ? {} : { parentThreadId: receipt.parentThreadId }
				}
			};
		});
		return {
			sessionId: binding.sessionId,
			...binding.workspace === void 0 ? {} : { workspace: binding.workspace },
			released: binding.released,
			...refs.find((ref) => ref.role === "canonical")?.threadId === void 0 ? {} : { canonicalThreadId: refs.find((ref) => ref.role === "canonical").threadId },
			refs
		};
	}
	assertManagementHealthy() {
		if (!this.storageHealthy) throw new Error(`codex-plugin-dsh: thread registry management is disabled because storage is unhealthy: ${this.lastError ?? "unknown error"}`);
	}
	lifecycleBlockReason(threadId, requireUnreferenced = false) {
		const receipt = this.receipts.get(threadId);
		if (receipt === void 0 || receipt.deleted) return "thread ownership is not proven";
		const references = this.referenceCount(threadId);
		if (requireUnreferenced ? references !== 0 : references > 1) return requireUnreferenced ? `thread still has ${references} DSH session reference(s)` : `thread is shared by ${references} DSH sessions`;
	}
	async performManagementIntent(intent, remote, commit) {
		const existing = this.intents.get(intent.threadId);
		if (existing !== void 0 && (existing.operationId !== intent.operationId || existing.action !== intent.action)) throw new Error(`codex-plugin-dsh: thread ${JSON.stringify(intent.threadId)} has pending ${existing.action} intent ${JSON.stringify(existing.operationId)}`);
		if (existing === void 0) {
			this.intents.set(intent.threadId, intent);
			await this.persist();
		}
		this.assertManagementHealthy();
		await remote();
		commit();
		this.intents.delete(intent.threadId);
		await this.persist();
	}
	restore(persisted) {
		this.receipts.clear();
		this.intents.clear();
		this.bindings.clear();
		for (const receipt of persisted.receipts) this.receipts.set(receipt.threadId, receipt);
		for (const intent of persisted.intents) this.intents.set(intent.threadId, intent);
		for (const item of persisted.sessions) this.bindings.set(item.sessionId, {
			sessionId: item.sessionId,
			...item.workspace === void 0 ? {} : { workspace: item.workspace },
			released: item.released,
			refs: new Map(item.refs.map((ref) => [ref.threadId, { ...ref }]))
		});
	}
	serialized() {
		return {
			version: REGISTRY_VERSION,
			updatedAt: Date.now(),
			receipts: [...this.receipts.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)),
			intents: [...this.intents.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)),
			sessions: [...this.bindings.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)).map((binding) => ({
				sessionId: binding.sessionId,
				...binding.workspace === void 0 ? {} : { workspace: binding.workspace },
				released: binding.released,
				refs: [...binding.refs.values()].sort((left, right) => left.threadId.localeCompare(right.threadId))
			}))
		};
	}
	persist() {
		if (this.storagePath === ":memory:") return Promise.resolve();
		if (!this.storageHealthy) return Promise.reject(/* @__PURE__ */ new Error(`codex-plugin-dsh: thread registry storage is unhealthy: ${this.lastError ?? "unknown error"}`));
		const payload = JSON.stringify(this.serialized(), null, 2) + "\n";
		const task = this.writeTail.then(async () => {
			await mkdir(dirname(this.storagePath), {
				recursive: true,
				mode: 448
			});
			const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temporary, payload, {
				encoding: "utf8",
				mode: 384
			});
			await rename(temporary, this.storagePath);
		});
		this.writeTail = task.catch(() => {});
		return task.catch((error) => {
			this.storageHealthy = false;
			this.lastError = thrown(error).message;
			throw error;
		});
	}
	async withStateLock(operation) {
		const prior = this.stateTail;
		const gate = Promise.withResolvers();
		const tail = prior.then(() => gate.promise);
		this.stateTail = tail;
		await prior;
		try {
			return await operation();
		} finally {
			gate.resolve();
			if (this.stateTail === tail) this.stateTail = Promise.resolve();
		}
	}
	async withOperation(key, operationId, operation) {
		if (operationId.trim().length === 0) throw new Error("codex-plugin-dsh: operationId must be non-empty");
		const prior = this.operationTails.get(key) ?? Promise.resolve();
		const gate = Promise.withResolvers();
		const tail = prior.then(() => gate.promise);
		this.operationTails.set(key, tail);
		await prior;
		try {
			return await operation();
		} finally {
			gate.resolve();
			if (this.operationTails.get(key) === tail) this.operationTails.delete(key);
		}
	}
};
//#endregion
//#region src/index.ts
const name = "codex-plugin-dsh";
const inject = [
	"llm",
	"subprocess",
	"sessions",
	"sessionPersistence",
	"attachments",
	"agents",
	"userQuestions"
];
const Config = z.object({
	executable: z.string().default("codex"),
	env: z.dict(z.string()).default({}),
	modelCacheMs: z.number().default(3e4),
	catalogTimeoutMs: z.number().default(1e4),
	turnTimeoutMs: z.number().default(36e5),
	disposeGraceMs: z.number().default(3e3),
	stderrMaxBytes: z.number().default(16384),
	modelPageSize: z.number().default(100),
	contextWindowTokens: z.number().default(0),
	modelContextWindows: z.dict(z.number()).default({ "gpt-5.6-sol": 1048576 }),
	registryPath: z.string().default(""),
	ephemeralOneShotSubagents: z.boolean().default(true),
	syncThreadNames: z.boolean().default(true),
	subagentSectionName: z.string().default("DSH 子代理")
});
function resolvedConfig(config) {
	const resolved = config;
	if (resolved.executable.trim().length === 0) throw new Error("codex-plugin-dsh: executable must be non-empty");
	const positive = [
		["catalogTimeoutMs", resolved.catalogTimeoutMs],
		["turnTimeoutMs", resolved.turnTimeoutMs],
		["disposeGraceMs", resolved.disposeGraceMs],
		["stderrMaxBytes", resolved.stderrMaxBytes]
	];
	for (const [field, value] of positive) if (!Number.isFinite(value) || value <= 0) throw new Error(`codex-plugin-dsh: ${field} must be positive and finite`);
	if (!Number.isFinite(resolved.modelCacheMs) || resolved.modelCacheMs < 0) throw new Error("codex-plugin-dsh: modelCacheMs must be non-negative and finite");
	if (!Number.isSafeInteger(resolved.modelPageSize) || resolved.modelPageSize <= 0) throw new Error("codex-plugin-dsh: modelPageSize must be a positive safe integer");
	if (!Number.isSafeInteger(resolved.contextWindowTokens) || resolved.contextWindowTokens < 0) throw new Error("codex-plugin-dsh: contextWindowTokens must be a non-negative safe integer");
	for (const [model, contextWindow] of Object.entries(resolved.modelContextWindows)) if (model.length === 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error("codex-plugin-dsh: modelContextWindows must map non-empty model ids to positive safe integers");
	const subagentSectionName = resolved.subagentSectionName.trim();
	if (Array.from(subagentSectionName).length > 100) throw new Error("codex-plugin-dsh: subagentSectionName must not exceed 100 characters");
	return {
		executable: resolved.executable,
		env: resolved.env,
		modelCacheMs: resolved.modelCacheMs,
		catalogTimeoutMs: resolved.catalogTimeoutMs,
		turnTimeoutMs: resolved.turnTimeoutMs,
		disposeGraceMs: resolved.disposeGraceMs,
		stderrMaxBytes: resolved.stderrMaxBytes,
		modelPageSize: resolved.modelPageSize,
		contextWindowTokens: resolved.contextWindowTokens,
		modelContextWindows: { ...resolved.modelContextWindows },
		ephemeralOneShotSubagents: resolved.ephemeralOneShotSubagents,
		syncThreadNames: resolved.syncThreadNames,
		subagentSectionName
	};
}
/** Register the adapter, rebuildable thread registry, and owned lifecycles. */
async function apply(ctx, config) {
	const adapter = new CodexAppServerAdapter(ctx, resolvedConfig(config));
	const registry = new CodexThreadRegistry(ctx, adapter, config.registryPath?.trim() || defaultCodexThreadRegistryPath());
	await registry.initialize();
	adapter.setThreadCreationObserver(registry);
	ctx.provide(CODEX_THREAD_REGISTRY_SERVICE, registry);
	ctx.llm.registerAdapter([CODEX_APP_SERVER_PROVIDER], adapter);
	ctx.on("session/event", (session, event) => registry.observeSessionEvent(session, event));
	ctx.on("session/disposed", (session) => adapter.disposeSession(String(session.id)));
	registry.reconcile().catch(() => {});
	ctx.effect(() => async () => {
		await adapter.dispose();
		await registry.dispose();
	}, "codex-plugin-dsh: close App Server turns and flush thread registry");
}
//#endregion
export { CODEX_APP_SERVER_PROVIDER, CODEX_THREAD_REGISTRY_SERVICE, CodexAppServerAdapter, CodexThreadRegistry, Config, apply, inject, name, resolveThreadPresentation };
