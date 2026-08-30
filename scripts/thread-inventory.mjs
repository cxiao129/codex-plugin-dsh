#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
const sessionsRoot = join(dshHome, 'sessions')
const sqlitePath = join(codexHome, 'state_5.sqlite')
const registryPath = join(dshHome, 'codex-plugin-dsh', 'thread-registry.json')
const outputPath = resolve(process.argv[2] || join(process.cwd(), 'reports', 'thread-inventory.json'))

function walk(root, result = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walk(path, result)
    else if (entry.isFile() && /^session\.jsonl(?:\.zstd)?$/.test(entry.name)) result.push(path)
  }
  return result
}

function readSession(path) {
  if (path.endsWith('.zstd')) {
    return execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  }
  return readFileSync(path, 'utf8')
}

function collectReplay(value, out) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectReplay(item, out)
    return
  }
  const raw = value.response && typeof value.response === 'object' ? value.response : value
  if (
    raw.kind === 'codex-app-server'
    && raw.version === 1
    && typeof raw.threadId === 'string'
    && typeof raw.turnId === 'string'
    && typeof raw.sessionId === 'string'
  ) {
    out.push({
      threadId: raw.threadId,
      turnId: raw.turnId,
      sessionId: raw.sessionId,
      toolSignature: typeof raw.toolSignature === 'string' ? raw.toolSignature : null,
    })
  }
  for (const child of Object.values(value)) collectReplay(child, out)
}

function sqliteJson(sql) {
  const text = execFileSync('sqlite3', ['-json', sqlitePath, sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
  return text ? JSON.parse(text) : []
}

const sessionFiles = walk(sessionsRoot)
const sessionRefs = []
const sessionErrors = []
for (const path of sessionFiles) {
  try {
    const text = readSession(path)
    const found = []
    let lineNo = 0
    for (const line of text.split('\n')) {
      lineNo += 1
      if (!line.includes('codex-app-server')) continue
      try {
        const value = JSON.parse(line)
        const before = found.length
        collectReplay(value, found)
        for (let index = before; index < found.length; index += 1) found[index].lineNo = lineNo
      } catch {
        // Packed or torn non-JSON rows are ignored; the report is conservative.
      }
    }
    const unique = []
    const seen = new Set()
    for (const ref of found) {
      const key = ref.sessionId + ':' + ref.threadId + ':' + ref.turnId
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(ref)
    }
    if (unique.length > 0) {
      sessionRefs.push({
        sessionId: unique.at(-1).sessionId,
        checkpoints: unique,
        canonicalThreadId: unique.at(-1).threadId,
        canonicalTurnId: unique.at(-1).turnId,
      })
    }
  } catch (error) {
    sessionErrors.push({ error: String(error?.message ?? error) })
  }
}

let registry = null
if (existsSync(registryPath)) {
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (error) {
    registry = { error: String(error?.message ?? error) }
  }
}
const receipts = new Map(
  Array.isArray(registry?.receipts)
    ? registry.receipts.filter((item) => item && typeof item.threadId === 'string').map((item) => [item.threadId, item])
    : [],
)

const threads = sqliteJson(`
  SELECT id, source, thread_source, has_user_event, archived, created_at_ms,
         updated_at_ms, cwd, title, model, preview
  FROM threads
  ORDER BY created_at_ms ASC, id ASC;
`)
const spawnEdges = sqliteJson('SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges;')
const spawnedChildren = new Set(spawnEdges.map((edge) => edge.child_thread_id))

const refsByThread = new Map()
for (const session of sessionRefs) {
  for (const checkpoint of session.checkpoints) {
    let value = refsByThread.get(checkpoint.threadId)
    if (value === undefined) {
      value = { sessionIds: new Set(), turnIds: new Set(), canonicalFor: new Set() }
      refsByThread.set(checkpoint.threadId, value)
    }
    value.sessionIds.add(session.sessionId)
    value.turnIds.add(checkpoint.turnId)
    if (checkpoint.threadId === session.canonicalThreadId) value.canonicalFor.add(session.sessionId)
  }
}

function classify(thread) {
  const refs = refsByThread.get(thread.id)
  if (refs !== undefined) return refs.canonicalFor.size > 0 ? 'referenced_canonical' : 'referenced_branch'
  if (receipts.has(thread.id)) return 'registry_owned_unreferenced'
  if (spawnedChildren.has(thread.id) || thread.thread_source === 'subagent' || String(thread.source).includes('"subagent"')) {
    return String(thread.source).includes('"guardian"') ? 'native_guardian' : 'native_subagent'
  }
  const title = String(thread.title || thread.preview || '')
  if (/mnemon|idle review|durable memory|记忆审查/i.test(title)) return 'mnemon_background_candidate'
  if (/provider-handoff|historical continuity|handoff/i.test(title)) return 'provider_handoff_candidate'
  if (/subagent|review code|audit|inspect|只读审计/i.test(title)) return 'background_task_candidate'
  if (thread.thread_source === 'user' || thread.has_user_event === 1) return 'interactive_user'
  return 'unreferenced_unclassified'
}

const rows = threads.map((thread) => {
  const refs = refsByThread.get(thread.id)
  return {
    id: thread.id,
    source: thread.source,
    threadSource: thread.thread_source,
    hasUserEvent: thread.has_user_event,
    archived: thread.archived,
    createdAtMs: thread.created_at_ms,
    updatedAtMs: thread.updated_at_ms,
    model: thread.model,
    category: classify(thread),
    referencedSessionIds: refs ? [...refs.sessionIds].sort() : [],
    checkpointTurnCount: refs?.turnIds.size ?? 0,
    registryOwned: receipts.has(thread.id),
  }
})
const counts = {}
for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  readOnly: true,
  sources: {
    dshSessionLogs: true,
    codexSqlite: existsSync(sqlitePath),
    threadRegistry: existsSync(registryPath),
  },
  caveats: [
    'No DSH session or Codex thread was archived, unarchived, or deleted.',
    'DSH session logs are authoritative for references; the registry is only a rebuildable ownership index.',
    'Unreferenced does not prove orphaned: Codex GUI, IDE, another DSH profile, or deleted DSH logs may still own a thread.',
    'Only registry creation receipts prove plugin ownership for destructive operations.',
    'Titles, previews, prompts, and workspace paths are intentionally omitted from report rows.',
  ],
  summary: {
    persistedDshSessionFiles: sessionFiles.length,
    dshSessionsWithCodexCheckpoints: sessionRefs.length,
    uniqueReferencedCodexThreads: refsByThread.size,
    codexThreads: rows.length,
    archivedCodexThreads: rows.filter((row) => row.archived === 1).length,
    registryReceiptCount: receipts.size,
    registryPresent: registry !== null,
    categoryCounts: counts,
    sessionReadErrors: sessionErrors.length,
  },
  sessions: sessionRefs,
  sessionErrors,
  threads: rows,
  spawnEdges,
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

const markdownPath = outputPath.replace(/\.json$/i, '.md')
const countLines = Object.entries(counts)
  .sort((left, right) => right[1] - left[1])
  .map(([category, count]) => `| ${category} | ${count} |`)
  .join('\n')
const markdown = `# Codex Thread Inventory

Generated: ${report.generatedAt}

This is a read-only classification report. No DSH session or Codex thread was
modified.

## Baseline

- Persisted DSH session files: ${report.summary.persistedDshSessionFiles}
- DSH sessions with Codex checkpoints: ${report.summary.dshSessionsWithCodexCheckpoints}
- Unique Codex threads referenced by DSH logs: ${report.summary.uniqueReferencedCodexThreads}
- Codex SQLite threads: ${report.summary.codexThreads}
- Archived Codex threads: ${report.summary.archivedCodexThreads}
- Registry ownership receipts: ${report.summary.registryReceiptCount}
- Session read errors: ${report.summary.sessionReadErrors}

## Classification

| Category | Count |
| --- | ---: |
${countLines}

## Interpretation

- referenced_canonical is the latest checkpoint thread for at least one
  persisted DSH session.
- referenced_branch is an older checkpoint thread still present in a DSH log.
- native_subagent and native_guardian are Codex-native worker threads; they are
  a different layer from DSH subagent sessions.
- Candidate categories are heuristics, not deletion authorization.
- unreferenced_unclassified may include Codex GUI/IDE work or threads whose DSH
  logs were removed. It must not be auto-purged.
- Only a current registry creation receipt, zero DSH references, and an inactive
  thread can authorize the optional purge service.

The full per-thread and per-session evidence is in
${outputPath.split('/').at(-1)}.
`
writeFileSync(markdownPath, markdown)
console.log(JSON.stringify({ outputPath, markdownPath, summary: report.summary }, null, 2))
