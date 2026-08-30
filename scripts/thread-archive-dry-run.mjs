#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DESCRIPTOR_VERSION = 2

function walkSessionFiles(root, result = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walkSessionFiles(path, result)
    else if (entry.isFile() && /^session\.jsonl(?:\.zstd)?$/.test(entry.name)) result.push(path)
  }
  return result
}

function readSessionText(path) {
  if (path.endsWith('.zstd')) {
    return execFileSync('zstd', ['-dc', path], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  }
  return readFileSync(path, 'utf8')
}

function parseLogicalRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    rows.push(JSON.parse(line))
  }
  return rows
}

function eventRows(rows) {
  return rows.slice(1).filter(row =>
    row !== null
    && typeof row === 'object'
    && typeof row.type === 'string'
    && row.type.includes('/'))
}

function ownSuffix(header, events) {
  const seedLength = Number.isSafeInteger(header.seedLength) && header.seedLength >= 0
    ? header.seedLength
    : 0
  return events.filter(event => !Number.isSafeInteger(event.seq) || event.seq >= seedLength)
}

function terminalEvidence(events) {
  let openTurns = 0
  let turnEndCount = 0
  let latestTurnEnd
  for (const event of events) {
    if (event.type === 'turn/start') openTurns += 1
    if (event.type === 'turn/end') {
      if (openTurns > 0) openTurns -= 1
      turnEndCount += 1
      latestTurnEnd = event
    }
  }
  return {
    openTurns,
    turnEndCount,
    terminal: openTurns === 0 && turnEndCount > 0 && events.at(-1)?.type === 'turn/end',
    lastEventType: events.at(-1)?.type ?? null,
    lastEventSeq: Number.isSafeInteger(events.at(-1)?.seq) ? events.at(-1).seq : null,
    outcomeKind: typeof latestTurnEnd?.data?.reason?.kind === 'string'
      ? latestTurnEnd.data.reason.kind
      : null,
  }
}

export function inspectSessionRows(rows) {
  const header = rows[0]
  if (
    header === null
    || typeof header !== 'object'
    || header.type !== 'session'
    || typeof header.id !== 'string'
  ) {
    throw new Error('first logical row is not a valid session header')
  }

  const events = eventRows(rows)
  const ownEvents = ownSuffix(header, events)
  const descriptorEvent = ownEvents.find(event => event.type === 'subagent/descriptor')
  const descriptor = descriptorEvent?.data
  const supportedDescriptor = descriptor !== null
    && typeof descriptor === 'object'
    && descriptor.version === DESCRIPTOR_VERSION
    && (descriptor.mode === 'one-shot' || descriptor.mode === 'continuable')

  return {
    sessionId: header.id,
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    delegationDepth: Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : null,
    descriptorSupported: supportedDescriptor,
    mode: supportedDescriptor ? descriptor.mode : null,
    ...terminalEvidence(ownEvents),
  }
}

export function evaluateArchiveCandidate({
  session,
  receipts,
  binding,
  referenceCount,
  pendingIntent,
  thread,
}) {
  const blockers = []
  const warnings = []

  if (session.origin !== 'subagent') blockers.push('session_origin_not_subagent')
  if (session.parentSessionId === null) blockers.push('parent_session_missing')
  if (!session.descriptorSupported) blockers.push('descriptor_missing_or_unsupported')
  if (session.mode !== 'one-shot') blockers.push('descriptor_not_one_shot')
  if (!session.terminal) blockers.push('dsh_own_turn_not_terminal')

  if (receipts.length === 0) {
    blockers.push('ownership_receipt_missing')
  } else if (receipts.length !== 1) {
    blockers.push('ownership_receipt_not_unique')
  }

  const receipt = receipts.length === 1 ? receipts[0] : undefined
  if (receipt?.deleted === true) blockers.push('ownership_receipt_marked_deleted')
  if (receipt !== undefined && receipt.sessionId !== session.sessionId) {
    blockers.push('ownership_receipt_session_mismatch')
  }

  if (binding === undefined) {
    blockers.push('registry_binding_missing')
  } else {
    if (binding.released === true) blockers.push('registry_binding_released')
    if (receipt !== undefined && !binding.refs?.some(ref => ref.threadId === receipt.threadId)) {
      blockers.push('registry_reference_missing')
    }
  }

  if (receipt !== undefined && referenceCount !== 1) {
    blockers.push(referenceCount === 0 ? 'registry_reference_released' : 'thread_shared_between_dsh_sessions')
  }
  if (pendingIntent !== undefined) blockers.push('registry_management_pending')
  if (receipt !== undefined && thread === undefined) blockers.push('codex_thread_missing')
  if (thread?.is_pinned === 1) blockers.push('codex_thread_pinned')

  const registryRef = receipt === undefined
    ? undefined
    : binding?.refs?.find(ref => ref.threadId === receipt.threadId)
  if (thread !== undefined && registryRef?.externalState === 'live' && thread.archived === 1) {
    warnings.push('registry_external_state_live_but_codex_archived')
  }
  if (thread !== undefined && registryRef?.externalState === 'archived' && thread.archived !== 1) {
    warnings.push('registry_external_state_archived_but_codex_live')
  }

  let status = 'blocked'
  if (blockers.length === 0) status = thread?.archived === 1 ? 'already_archived' : 'eligible_after_live_check'

  return {
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    threadId: receipt?.threadId ?? null,
    status,
    blockers,
    warnings,
    dshOutcomeKind: session.outcomeKind,
    dshLastEventType: session.lastEventType,
    dshLastEventSeq: session.lastEventSeq,
    codexArchived: thread?.archived === 1,
    requiredAtExecution: status === 'eligible_after_live_check'
      ? [
          'registry must report no active App Server turn for the DSH session',
          'thread/read must report a head status other than inProgress',
        ]
      : [],
  }
}

function sqliteJson(sqlitePath, sql) {
  const text = execFileSync('sqlite3', ['-json', sqlitePath, sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return text.length === 0 ? [] : JSON.parse(text)
}

function countBy(values, key) {
  const counts = {}
  for (const value of values) {
    const name = value[key]
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

export function generateArchiveDryRun({
  dshHome,
  codexHome,
}) {
  const sessionsRoot = join(dshHome, 'sessions')
  const sqlitePath = join(codexHome, 'state_5.sqlite')
  const registryPath = join(dshHome, 'codex-plugin-dsh', 'thread-registry.json')
  const sessionFiles = walkSessionFiles(sessionsRoot)

  const registry = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf8'))
    : { receipts: [], intents: [], sessions: [] }
  const allReceipts = Array.isArray(registry.receipts) ? registry.receipts : []
  const bindings = Array.isArray(registry.sessions) ? registry.sessions : []
  const intents = Array.isArray(registry.intents) ? registry.intents : []

  const receiptsBySession = new Map()
  for (const receipt of allReceipts) {
    if (receipt === null || typeof receipt !== 'object' || typeof receipt.sessionId !== 'string') continue
    const values = receiptsBySession.get(receipt.sessionId) ?? []
    values.push(receipt)
    receiptsBySession.set(receipt.sessionId, values)
  }
  const bindingBySession = new Map(bindings
    .filter(binding => binding && typeof binding.sessionId === 'string')
    .map(binding => [binding.sessionId, binding]))
  const intentByThread = new Map(intents
    .filter(intent => intent && typeof intent.threadId === 'string')
    .map(intent => [intent.threadId, intent]))

  const activeReferenceCounts = new Map()
  for (const binding of bindings) {
    if (binding?.released === true || !Array.isArray(binding?.refs)) continue
    for (const ref of binding.refs) {
      if (typeof ref?.threadId !== 'string') continue
      activeReferenceCounts.set(ref.threadId, (activeReferenceCounts.get(ref.threadId) ?? 0) + 1)
    }
  }

  const codexThreads = existsSync(sqlitePath)
    ? sqliteJson(sqlitePath, `
        SELECT id, archived, is_pinned
        FROM threads
        ORDER BY id ASC;
      `)
    : []
  const threadById = new Map(codexThreads.map(thread => [thread.id, thread]))

  const errors = []
  const sessions = []
  for (const path of sessionFiles) {
    try {
      sessions.push(inspectSessionRows(parseLogicalRows(readSessionText(path))))
    } catch {
      // Paths and raw parser diagnostics can contain workspace data. The report
      // records only a stable reason code and aggregate count.
      errors.push({ code: 'session_read_failed' })
    }
  }

  const oneShots = sessions.filter(session => session.mode === 'one-shot')
  const candidates = oneShots.map(session => {
    const receipts = receiptsBySession.get(session.sessionId) ?? []
    const receipt = receipts.length === 1 ? receipts[0] : undefined
    return evaluateArchiveCandidate({
      session,
      receipts,
      binding: bindingBySession.get(session.sessionId),
      referenceCount: receipt === undefined ? 0 : (activeReferenceCounts.get(receipt.threadId) ?? 0),
      pendingIntent: receipt === undefined ? undefined : intentByThread.get(receipt.threadId),
      thread: receipt === undefined ? undefined : threadById.get(receipt.threadId),
    })
  }).sort((left, right) => left.sessionId.localeCompare(right.sessionId))

  const blockerCounts = {}
  const warningCounts = {}
  for (const candidate of candidates) {
    for (const blocker of candidate.blockers) blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1
    for (const warning of candidate.warnings) warningCounts[warning] = (warningCounts[warning] ?? 0) + 1
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    action: 'none',
    sources: {
      dshSessionLogs: existsSync(sessionsRoot),
      threadRegistry: existsSync(registryPath),
      codexSqlite: existsSync(sqlitePath),
    },
    guarantees: [
      'No DSH session or Codex thread is archived, unarchived, deleted, renamed, or moved.',
      'A title, preview, prompt, model response, workspace path, and rollout path never appear in this report.',
      'Only an exact plugin creation receipt tied to the durable one-shot child session can pass the ownership gate.',
      'An actual archive must still use the registry lifecycle path, which fences active DSH turns and checks thread/read for inProgress.',
    ],
    caveats: [
      'The DSH JSONL does not contain a separate parent-delivery receipt for synchronous one-shot results; a terminal own turn proves the child settled, while the parent keeps its own tool result.',
      'Codex SQLite archived state is used only for read-only presentation. It is not a substitute for App Server lifecycle RPCs.',
      'Registry externalState can lag manual or external ChatGPT/Codex archive operations; mismatches are warnings and are never auto-repaired.',
      'Blocked rows are evidence gaps, not evidence that a thread is unsafe or user-created.',
    ],
    summary: {
      persistedDshSessionFiles: sessionFiles.length,
      parsedDshSessions: sessions.length,
      subagentSessions: sessions.filter(session => session.origin === 'subagent').length,
      oneShotSubagentSessions: oneShots.length,
      continuableSubagentSessions: sessions.filter(session => session.mode === 'continuable').length,
      unclassifiedSubagentSessions: sessions.filter(session => session.origin === 'subagent' && session.mode === null).length,
      terminalOneShotSessions: oneShots.filter(session => session.terminal).length,
      registryReceiptCount: allReceipts.length,
      codexThreadCount: codexThreads.length,
      sessionReadErrors: errors.length,
      statusCounts: countBy(candidates, 'status'),
      blockerCounts,
      warningCounts,
    },
    candidates,
    errors,
  }
}

function markdownReport(report, jsonName) {
  const statusLines = Object.entries(report.summary.statusCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([status, count]) => `| ${status} | ${count} |`)
    .join('\n')
  const blockerLines = Object.entries(report.summary.blockerCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join('\n') || '| — | 0 |'
  const warningLines = Object.entries(report.summary.warningCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join('\n') || '| — | 0 |'

  return `# Codex One-shot Thread Archive Dry-run

Generated: ${report.generatedAt}

This report is read-only. It did not archive, delete, rename, move, or otherwise
modify any DSH session or Codex thread.

## Scope

- Persisted DSH session files: ${report.summary.persistedDshSessionFiles}
- Parsed DSH sessions: ${report.summary.parsedDshSessions}
- One-shot subagent sessions: ${report.summary.oneShotSubagentSessions}
- Terminal one-shot sessions: ${report.summary.terminalOneShotSessions}
- Continuable subagent sessions (never candidates): ${report.summary.continuableSubagentSessions}
- Unclassified subagent sessions (never candidates): ${report.summary.unclassifiedSubagentSessions}
- Registry creation receipts: ${report.summary.registryReceiptCount}
- Codex SQLite threads: ${report.summary.codexThreadCount}
- Session read errors: ${report.summary.sessionReadErrors}

## Decisions

| Status | Count |
| --- | ---: |
${statusLines}

\`eligible_after_live_check\` means every durable and ownership gate passed, but
an actual archive must still go through the plugin registry so it can reject a
live DSH session or an App Server head whose status is \`inProgress\`.

\`already_archived\` needs no action. \`blocked\` means evidence was missing,
shared, released, pinned, pending, or non-terminal; titles and prompt heuristics
never authorize an archive.

## Blockers

| Reason | Count |
| --- | ---: |
${blockerLines}

## Warnings

| Warning | Count |
| --- | ---: |
${warningLines}

## Safety boundary

- This manifest intentionally contains only session ids, parent ids, thread ids,
  terminal metadata, archive flags, and reason codes.
- It omits titles, previews, prompts, model output, workspaces, and rollout paths.
- It never writes Codex SQLite. Future execution must use App Server lifecycle
  methods through the ownership registry and remain reversible by unarchive.
- Deletion is outside this dry-run and is not authorized by this report.

The complete reason-coded manifest is in ${jsonName}.
`
}

function main() {
  const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
  const outputPath = resolve(process.argv[2] || join(process.cwd(), 'reports', 'thread-archive-dry-run.json'))
  const report = generateArchiveDryRun({ dshHome, codexHome })

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
  const markdownPath = outputPath.replace(/\.json$/i, '.md')
  writeFileSync(markdownPath, markdownReport(report, outputPath.split('/').at(-1)))

  console.log(JSON.stringify({
    outputPath,
    markdownPath,
    summary: report.summary,
  }, null, 2))
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) main()
