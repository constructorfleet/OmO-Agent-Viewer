import type { TerminalSnapshot } from "./terminals.js"

export interface TranscriptDocument {
  readonly lines: readonly string[]
  readonly lineTurns: readonly (string | undefined)[]
  readonly turns: readonly TranscriptTurn[]
  readonly todo?: TodoState
  /** Monitors and background shells recorded in the same session file. */
  readonly terminals?: TerminalSnapshot
}

export type TodoStatus = "pending" | "in_progress" | "completed"

export interface TodoItem {
  readonly text: string
  readonly status: TodoStatus
}

export interface TodoPhase {
  readonly name: string
  readonly items: readonly TodoItem[]
}

export interface TodoState {
  readonly done: number
  readonly total: number
  readonly open: number
  readonly now?: string
  readonly next?: string
  readonly activePhase?: string
  readonly phases: readonly TodoPhase[]
  readonly remaining: readonly TodoItem[]
}

export interface SessionTranscriptOptions {
  readonly toolDetail?: boolean
  readonly thinkingPreview?: boolean
}

export interface TranscriptToolCall {
  readonly id?: string
  readonly name: string
  readonly arguments: unknown
}

export interface TranscriptToolResult {
  readonly callId?: string
  readonly name?: string
  readonly isError: boolean
  readonly text?: string
  readonly images?: readonly TranscriptImage[]
  /** Checklist carried by a todo call, including calls nested inside an eval tool result. */
  readonly todo?: TodoState
}

export interface TranscriptImage {
  readonly mimeType: string
  /** Base64 payload as stored in the session entry; decoded only when a preview is shown. */
  readonly data: string
}

export type TranscriptTurnPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "call"; readonly call: TranscriptToolCall }

export interface TranscriptTurn {
  readonly id: string
  readonly thinking: readonly string[]
  readonly parts: readonly TranscriptTurnPart[]
  readonly results: readonly TranscriptToolResult[]
}

interface MutableTurn {
  id: string
  thinking: string[]
  parts: TranscriptTurnPart[]
  results: TranscriptToolResult[]
}

export function parseEventTranscript(text: string): readonly string[] {
  const lines: string[] = []
  eachEvent(text, (type, payload) => {
    if (type === "assistant_message" && typeof payload.text === "string") {
      lines.push(...safeText(payload.text).split("\n").map((part) => `assistant: ${part}`))
    } else if (type === "tool_execution" && typeof payload.tool === "string") {
      lines.push(`${payload.is_error === true ? "tool[error]" : "tool"}: ${safeText(payload.tool)}`)
    } else if (type === "child_error" && typeof payload.message === "string") {
      lines.push(`error: ${safeText(payload.message)}`)
    }
  })
  return lines
}

export function parseEventErrors(text: string): readonly string[] {
  const errors: string[] = []
  eachEvent(text, (type, payload) => {
    if (type === "child_error" && typeof payload.message === "string") errors.push(payload.message)
  })
  return errors
}

export function buildTranscriptDocument(
  turns: readonly TranscriptTurn[],
  errors: readonly string[] = [],
): TranscriptDocument {
  const chunks = turns.map((turn) => ({
    turnId: turn.id,
    lines: formatSessionTranscript([turn], { toolDetail: true, thinkingPreview: true }),
  }))
  const lines = chunks.flatMap((chunk) => chunk.lines)
  const lineTurns = chunks.flatMap((chunk) => chunk.lines.map(() => chunk.turnId))
  const uniqueErrors = [...new Set(errors)]
  const todo = lastTodoReport(turns)
  const document: TranscriptDocument = {
    lines: uniqueErrors.length === 0 ? lines : [...lines, ...uniqueErrors.map((error) => `error: ${safeText(error)}`)],
    lineTurns: uniqueErrors.length === 0 ? lineTurns : [...lineTurns, ...uniqueErrors.map(() => undefined)],
    turns,
    ...(todo === undefined ? {} : { todo }),
  }
  return document
}

export function parseTodoReport(text: string): TodoState | undefined {
  const lines = text.split("\n").map((line) => line.trimEnd())
  const overall = firstMatch(lines, /^Overall: (\d+)\/(\d+) done, (\d+) open\.?$/)
  const now = lines.find((line) => line.startsWith("Now: "))?.slice(5).trim()
  const next = lines.find((line) => line.startsWith("Next: "))?.slice(6).trim()
  const active = firstMatch(lines, /^Active phase \d+\/\d+ "([^"]+)"/)
  const remaining: TodoItem[] = []
  const phases: TodoPhase[] = []
  let inRemaining = false
  let phase: { name: string; items: TodoItem[] } | undefined
  for (const line of lines) {
    if (/^Remaining items \(\d+\):$/.test(line.trim())) {
      inRemaining = true
      phase = undefined
      continue
    }
    if (inRemaining) {
      const item = /^ {2}- (.*?) \[(pending|in_progress)\](?: \((.*)\))?$/.exec(line)
      if (item !== null) {
        remaining.push({ text: item[1] ?? "", status: item[2] as TodoStatus })
        continue
      }
      if (line.trim() !== "") inRemaining = false
    }
    const phaseMatch = /^ {2}([^\s].*):$/.exec(line)
    if (phaseMatch !== null && !/^ {2}(Remaining items|Overall|Active phase)/.test(line)) {
      phase = { name: phaseMatch[1] ?? "", items: [] }
      phases.push(phase)
      continue
    }
    const item = /^ {4}- \[([ Xx])\] (.*)$/.exec(line)
    if (item !== null && phase !== undefined) {
      const raw = item[2] ?? ""
      const inProgress = raw.endsWith(" (in progress)")
      const status: TodoStatus = item[1] === " " ? (inProgress ? "in_progress" : "pending") : "completed"
      phase.items.push({ text: raw.replace(/ \(in progress\)$/, ""), status })
    }
  }
  if (overall === undefined && phases.length === 0 && remaining.length === 0) return undefined
  const phaseItems = phases.flatMap((entry) => entry.items)
  const done = overall === undefined ? phaseItems.filter((item) => item.status === "completed").length : Number(overall[1])
  const total = overall === undefined ? phaseItems.length : Number(overall[2])
  const open = overall === undefined ? total - done : Number(overall[3])
  return {
    done,
    total,
    open,
    ...(now === undefined || now.length === 0 ? {} : { now }),
    ...(next === undefined || next.length === 0 ? {} : { next }),
    ...(active === undefined ? {} : { activePhase: active[1] }),
    phases,
    remaining,
  }
}

function firstMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | undefined {
  for (const line of lines) {
    const match = pattern.exec(line.trim())
    if (match !== null) return match
  }
  return undefined
}

function lastTodoReport(turns: readonly TranscriptTurn[]): TodoState | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const results = turns[turnIndex]?.results ?? []
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const result = results[index]
      if (result?.todo !== undefined) return result.todo
      if (result?.name !== "todo" || result.text === undefined) continue
      const todo = parseTodoReport(result.text)
      if (todo !== undefined) return todo
    }
  }
  return undefined
}

/**
 * The main agent now batches todo calls inside `eval`, so the checklist lives in the eval
 * result's `details` instead of a top-level `todo` result. Older direct results carry the
 * same `details` shape; prefer it so abandoned items and counts match the rendered report.
 */
function resultTodo(message: Record<string, unknown>): TodoState | undefined {
  const direct = parseTodoDetails(message.details)
  if (direct !== undefined) return direct
  const details = message.details
  if (!isRecord(details) || !Array.isArray(details.toolCalls)) return undefined
  let todo: TodoState | undefined
  for (const call of details.toolCalls) {
    if (!isRecord(call) || call.name !== "todo") continue
    const parsed = parseTodoDetails(call.details)
    if (parsed !== undefined) todo = parsed
  }
  return todo
}

function parseTodoDetails(value: unknown): TodoState | undefined {
  if (!isRecord(value) || !Array.isArray(value.phases)) return undefined
  const phases: TodoPhase[] = []
  const openItems: { readonly item: TodoItem; readonly phase: string }[] = []
  let done = 0
  let total = 0
  for (const phaseValue of value.phases) {
    if (!isRecord(phaseValue) || typeof phaseValue.name !== "string" || !Array.isArray(phaseValue.tasks)) continue
    const items: TodoItem[] = []
    for (const taskValue of phaseValue.tasks) {
      if (!isRecord(taskValue) || typeof taskValue.content !== "string") continue
      total += 1
      if (taskValue.status === "abandoned") {
        // The rendered report drops abandoned steps but still counts them as done.
        done += 1
        continue
      }
      const status: TodoStatus =
        taskValue.status === "completed"
          ? "completed"
          : taskValue.status === "in_progress"
            ? "in_progress"
            : "pending"
      if (status === "completed") done += 1
      else openItems.push({ item: { text: taskValue.content, status }, phase: phaseValue.name })
      items.push({ text: taskValue.content, status })
    }
    if (items.length > 0) phases.push({ name: phaseValue.name, items })
  }
  if (total === 0) return undefined

  const inProgressIndex = openItems.findIndex((entry) => entry.item.status === "in_progress")
  const nowIndex = inProgressIndex === -1 ? 0 : inProgressIndex
  const nowEntry = openItems[nowIndex]
  const nextEntry = openItems[nowIndex + 1]
  return {
    done,
    total,
    open: total - done,
    ...(nowEntry === undefined ? {} : { now: todoEntryLabel(nowEntry) }),
    ...(nextEntry === undefined ? {} : { next: todoEntryLabel(nextEntry) }),
    ...(nowEntry === undefined ? {} : { activePhase: nowEntry.phase }),
    phases,
    remaining: openItems.map((entry) => entry.item),
  }
}

function todoEntryLabel(entry: { readonly item: TodoItem; readonly phase: string }): string {
  return entry.phase.length === 0 ? entry.item.text : `${entry.item.text} (${entry.phase})`
}

export function buildEventDocument(lines: readonly string[]): TranscriptDocument {
  return { lines, lineTurns: lines.map(() => undefined), turns: [] }
}

export function parseSessionTurns(text: string): readonly TranscriptTurn[] {
  const turns: MutableTurn[] = []
  const turnByCallId = new Map<string, MutableTurn>()
  let current: MutableTurn | undefined
  for (const line of text.split("\n")) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue
    const message = entry.message
    if (!Array.isArray(message.content)) continue
    if (message.role === "assistant") {
      current = { id: turnId(entry, turns.length), thinking: [], parts: [], results: [] }
      turns.push(current)
      for (const part of message.content) {
        if (!isRecord(part)) continue
        if (part.type === "thinking" && typeof part.thinking === "string") {
          current.thinking.push(safeText(part.thinking))
        } else if (part.type === "text" && typeof part.text === "string") {
          current.parts.push({ kind: "text", text: safeText(part.text) })
        } else if (part.type === "toolCall" && typeof part.name === "string") {
          const call: TranscriptToolCall = {
            name: safeText(part.name),
            arguments: part.arguments,
            ...(typeof part.id === "string" ? { id: part.id } : {}),
          }
          current.parts.push({ kind: "call", call })
          if (call.id !== undefined) turnByCallId.set(call.id, current)
        }
      }
    } else if (message.role === "toolResult") {
      const text = resultText(message.content)
      const images = resultImages(message.content)
      const todo = resultTodo(message)
      const result: TranscriptToolResult = {
        isError: message.isError === true,
        ...(typeof message.toolCallId === "string" ? { callId: message.toolCallId } : {}),
        ...(typeof message.toolName === "string" ? { name: safeText(message.toolName) } : {}),
        ...(text === undefined ? {} : { text }),
        ...(images === undefined ? {} : { images }),
        ...(todo === undefined ? {} : { todo }),
      }
      const target = result.callId === undefined ? undefined : turnByCallId.get(result.callId)
      ;(target ?? current)?.results.push(result)
    }
  }
  return turns
}

export function formatSessionTranscript(
  turns: readonly TranscriptTurn[],
  options: SessionTranscriptOptions = {},
): readonly string[] {
  const lines: string[] = []
  const toolDetail = options.toolDetail === true
  for (const turn of turns) {
    if (options.thinkingPreview === true) {
      const preview = thinkingPreview(turn.thinking)
      if (preview !== undefined) lines.push(`thinking: ${preview}`)
    }
    for (const part of turn.parts) {
      if (part.kind === "text") {
        if (part.text.length > 0) lines.push(...part.text.split("\n").map((textLine) => `assistant: ${textLine}`))
      } else if (toolDetail) {
        lines.push(toolCallLine(part.call.name, part.call.arguments))
      }
    }
    if (toolDetail) {
      for (const result of turn.results) {
        const line = toolResultLine(result)
        if (line !== undefined) lines.push(line)
      }
    }
  }
  return lines
}

export function formatTurnBody(turn: TranscriptTurn): readonly string[] {
  const lines: string[] = []
  if (turn.thinking.length > 0) {
    lines.push("THINKING")
    for (const thinking of turn.thinking) lines.push(...indentLines(cappedLines(thinking, THINKING_DETAIL_LIMIT), "  "))
    lines.push("")
  }
  const texts = turn.parts.filter(
    (part): part is { readonly kind: "text"; readonly text: string } => part.kind === "text" && part.text.length > 0,
  )
  if (texts.length > 0) {
    lines.push("ASSISTANT")
    for (const part of texts) lines.push(...indentLines(cappedLines(part.text, THINKING_DETAIL_LIMIT), "  "))
    lines.push("")
  }
  for (const part of turn.parts) {
    if (part.kind !== "call") continue
    lines.push(`CALL ${part.call.name}`)
    const argumentLines = formatArguments(part.call.arguments)
    lines.push(...(argumentLines.length === 0 ? ["  (no arguments)"] : indentLines(argumentLines, "  ")))
    lines.push("")
  }
  if (turn.results.length > 0) {
    lines.push("RESULTS")
    for (const result of turn.results) {
      const line = toolResultLine(result)
      if (line !== undefined) lines.push(`  ${line}`)
    }
  }
  return lines
}

export function summarizeTurn(turn: TranscriptTurn): string {
  const names = [...new Set(turn.parts.flatMap((part) => (part.kind === "call" ? [part.call.name] : [])))]
  const text = turn.thinking.join(" ") || turn.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join(" ")
  const calls = names.length === 0
    ? "no calls"
    : `${names.length} call${names.length === 1 ? "" : "s"}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`
  return [calls, shorten(text, TURN_SUMMARY_LIMIT)].filter((part) => part.length > 0).join(" · ")
}

const DETAIL_LIMIT = 120
const DETAIL_TOTAL_LIMIT = 140
const THINKING_PREVIEW_LIMIT = 120
const THINKING_DETAIL_LIMIT = 8_000
const ARGUMENT_DETAIL_LIMIT = 4_000
const TURN_SUMMARY_LIMIT = 90
const DETAIL_KEYS = ["command", "path", "query", "pattern", "url", "task", "description", "summary", "prompt", "input", "code", "op"]
// The todo tool echoes its checklist, which is already represented by the task rows.
const QUIET_RESULT_TOOLS = new Set(["todo"])

function eachEvent(text: string, visit: (type: string, payload: Record<string, unknown>) => void): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(entry) || typeof entry.type !== "string" || !isRecord(entry.payload)) continue
    visit(entry.type, entry.payload)
  }
}

function shorten(text: string, limit: number): string {
  const collapsed = collapseText(text)
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 3)}...` : collapsed
}

function collapseText(text: string): string {
  return safeText(text).replace(/\s+/g, " ").trim()
}

function thinkingPreview(thinking: readonly string[]): string | undefined {
  const preview = shorten(thinking.join(" "), THINKING_PREVIEW_LIMIT)
  return preview.length > 0 ? preview : undefined
}

function toolCallLine(name: string, args: unknown): string {
  const detail = toolCallDetail(args)
  const tool = safeText(name)
  return detail === undefined ? `tool: ${tool}` : `tool: ${tool} ${detail}`
}

function toolCallDetail(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const parts: string[] = []
  for (const key of DETAIL_KEYS) {
    if (parts.length >= 2) break
    const part = previewArgument(key, args[key])
    if (part === undefined) continue
    if (parts.length > 0 && `${parts.join(" ")} ${part}`.length > DETAIL_TOTAL_LIMIT) break
    parts.push(part)
  }
  if (parts.length > 0) return parts.join(" ")
  for (const [key, value] of Object.entries(args)) {
    const part = previewArgument(key, value)
    if (part !== undefined) return part
  }
  return undefined
}

function previewArgument(key: string, value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined
  const text = collapseText(String(value))
  if (text.length === 0) return undefined
  const shown = text.length <= DETAIL_LIMIT
    ? text
    : key === "path"
      ? `...${text.slice(-(DETAIL_LIMIT - 3))}`
      : `${text.slice(0, DETAIL_LIMIT - 3)}...`
  return `${key}=${JSON.stringify(shown)}`
}

function formatArguments(args: unknown): readonly string[] {
  if (!isRecord(args)) return args === undefined ? [] : cappedLines(String(args), ARGUMENT_DETAIL_LIMIT)
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      if (value.length === 0) {
        lines.push(`${key}: ""`)
        continue
      }
      lines.push(`${key}:`)
      lines.push(...indentLines(cappedLines(value, ARGUMENT_DETAIL_LIMIT), "  "))
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`)
    } else if (value !== undefined) {
      lines.push(`${key}:`)
      lines.push(...indentLines(cappedLines(JSON.stringify(value, null, 2) ?? "", ARGUMENT_DETAIL_LIMIT), "  "))
    }
  }
  return lines
}

function cappedLines(text: string, limit: number): readonly string[] {
  const safe = safeText(text)
  if (safe.length <= limit) return safe.split("\n")
  const lines = safe.slice(0, limit).split("\n")
  lines.push(`... (${safe.length - limit} more chars)`)
  return lines
}

function indentLines(lines: readonly string[], indent: string): readonly string[] {
  return lines.map((line) => `${indent}${line}`)
}

function toolResultLine(result: TranscriptToolResult): string | undefined {
  if (result.name !== undefined && QUIET_RESULT_TOOLS.has(result.name)) return undefined
  const label = result.isError ? "result[error]" : "result"
  const prefix = result.name === undefined ? label : `${label}(${result.name})`
  const imageCount = result.images?.length ?? 0
  const imageTag = imageCount === 0 ? "" : ` [${imageCount} image${imageCount === 1 ? "" : "s"}]`
  const text = result.text
  if (text === undefined) return `${prefix}: no output${imageTag}`
  const contentLines = text.split("\n").filter((contentLine) => contentLine.trim().length > 0)
  const preview = contentLines.find((contentLine) => /[\p{L}\p{N}]/u.test(contentLine)) ?? contentLines[0] ?? ""
  const summary = shorten(preview, DETAIL_LIMIT)
  const line = contentLines.length > 1 ? `${prefix}: ${summary} (${contentLines.length} lines)` : `${prefix}: ${summary}`
  return `${line}${imageTag}`
}

function resultImages(content: unknown): readonly TranscriptImage[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: TranscriptImage[] = []
  for (const part of content) {
    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string" || part.data.length === 0) continue
    images.push({ mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png", data: part.data })
  }
  return images.length === 0 ? undefined : images
}

function resultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(safeText(part.text))
  }
  const text = parts.join("\n").trim()
  return text.length > 0 ? text : undefined
}

function turnId(entry: Record<string, unknown>, index: number): string {
  for (const value of [entry.id, entry.timestamp]) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return `turn-${index}`
}

export function safeText(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
