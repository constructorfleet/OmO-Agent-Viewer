import { basename } from "node:path"

import { BoxRenderable, RGBA, StyledText, TextRenderable, bold, createCliRenderer, dim } from "@opentui/core"

import { isTerminalDagState } from "./dag.js"
import { projectTaskTree, type TaskTreeItem } from "./state.js"
import { loadDagRuns, loadTaskRecords, readRootDocument, readTaskActivity, readTaskDocument } from "./task-store.js"
import type { TranscriptDocument } from "./transcript.js"
import type { PreviewCell } from "./image-preview.js"
import {
  EMPTY_TRANSCRIPT,
  RAIL_COLOR,
  clampViewer,
  initialViewerState,
  projectViewer,
  reconcileViewer,
  updateViewer,
  viewedItem,
  type PaneFrame,
  type RowStyle,
  type ViewerContext,
  type ViewerData,
  type ViewerFrame,
  type ViewerInput,
  type ViewerLimits,
  type ViewerState,
  type ViewerViewport,
} from "./viewer-model.js"

export interface ViewerOptions {
  readonly projectDir: string
  readonly agentDir: string
  readonly stateDir: string
  readonly refreshMs: number
  readonly readBytes: number
}

interface StoreLoad {
  readonly items: readonly TaskTreeItem[]
  readonly invalidRecords: number
  readonly error?: string
}

interface TargetLoad {
  readonly transcript: TranscriptDocument
  readonly key?: string
  readonly error?: string
}

const ZERO_LIMITS: ViewerLimits = { transcriptScroll: 0, todoScroll: 0 }

export async function runViewer(options: ViewerOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  renderer.setTerminalTitle(`${basename(options.projectDir) || options.projectDir} · OmO Agent Viewer`)
  const shell = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: "#0b1020",
  })
  const header = new TextRenderable(renderer, { content: "OMO AGENTS  •  loading task store", fg: "#8be9fd" })
  const content = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })
  const leftColumn = new BoxRenderable(renderer, {
    width: "35%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
  })
  const listPanel = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
  })
  const detailPanel = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
  })
  const rightColumn = new BoxRenderable(renderer, {
    width: "65%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
  })
  const listText = new TextRenderable(renderer, {
    content: "",
    fg: "#d8dee9",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  const detailText = new TextRenderable(renderer, {
    content: "",
    fg: "#cbd5e1",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  const footer = new TextRenderable(renderer, {
    content: "↑/↓ select  enter/→ expand  o open  esc main  t newest turn  l todo  j/k scroll  g latest  p pause  r refresh  q quit",
    fg: "#7c8aa5",
  })
  const todoPanel = new BoxRenderable(renderer, {
    width: "100%",
    height: 0,
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
    visible: false,
  })
  const todoText = new TextRenderable(renderer, {
    content: "",
    fg: "#cbd5e1",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  todoPanel.add(todoText)
  const terminalsPanel = new BoxRenderable(renderer, {
    width: "100%",
    height: 0,
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
    visible: false,
  })
  const terminalsText = new TextRenderable(renderer, {
    content: "",
    fg: "#cbd5e1",
    selectable: false,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })
  terminalsPanel.add(terminalsText)
  listPanel.add(listText)
  detailPanel.add(detailText)
  leftColumn.add(listPanel)
  leftColumn.add(todoPanel)
  rightColumn.add(detailPanel)
  rightColumn.add(terminalsPanel)
  content.add(leftColumn)
  content.add(rightColumn)
  shell.add(header)
  shell.add(content)
  shell.add(footer)
  renderer.root.add(shell)

  let state: ViewerState = initialViewerState([])
  let data: ViewerData = {
    items: [],
    transcript: EMPTY_TRANSCRIPT,
    projectDir: options.projectDir,
    refreshMs: options.refreshMs,
    invalidRecords: 0,
  }
  let dataTargetKey: string | undefined
  let frame: ViewerFrame | undefined
  let closed = false
  let scheduled = false
  let focusSelection = false

  const widthOf = (renderable: TextRenderable): number =>
    Number.isFinite(renderable.width) && renderable.width > 0 ? Math.floor(renderable.width) : 0
  const heightOf = (renderable: TextRenderable): number =>
    Number.isFinite(renderable.height) && renderable.height > 0 ? Math.floor(renderable.height) : 0
  const measure = (): ViewerViewport => {
    const contentWidth = Math.max(20, renderer.width - 2)
    const listPanelWidth = Math.max(10, Math.floor(contentWidth * 0.35))
    return {
      listWidth: widthOf(listText) || Math.max(10, listPanelWidth - 4),
      listHeight: heightOf(listText) || Math.max(3, renderer.height - 12),
      detailWidth: widthOf(detailText) || Math.max(20, contentWidth - listPanelWidth - 5),
      detailHeight: heightOf(detailText) || Math.max(3, renderer.height - 12),
      todoWidth: widthOf(todoText) || Math.max(10, listPanelWidth - 4),
      todoHeight: Math.max(4, Math.min(10, Math.floor(renderer.height * 0.3))),
      terminalsWidth: widthOf(terminalsText) || Math.max(20, contentWidth - listPanelWidth - 5),
      terminalsHeight: Math.max(4, Math.min(12, Math.floor(renderer.height * 0.3))),
    }
  }
  const context = (): ViewerContext => ({
    items: data.items,
    transcript: data.transcript,
    limits: frame?.limits ?? ZERO_LIMITS,
  })

  const targetFor = (
    current: ViewerState,
    items: readonly TaskTreeItem[],
  ): { readonly key: string; readonly read: () => TranscriptDocument } | undefined => {
    const viewed = viewedItem(current, items)
    if (viewed === undefined || viewed.kind === "run") return undefined
    if (viewed.kind === "main") {
      const readOptions = { maxBytes: options.readBytes }
      return { key: `main:${viewed.rootSessionId}`, read: () => readRootDocument(options.agentDir, viewed.rootSessionId, readOptions) }
    }
    const readOptions = { maxBytes: options.readBytes }
    return { key: `task:${viewed.id}`, read: () => readTaskDocument(options.stateDir, viewed.id, readOptions) }
  }

  const loadStore = (): StoreLoad => {
    try {
      const snapshot = loadTaskRecords(options.stateDir)
      const dag = loadDagRuns(options.stateDir)
      const activity = new Map<string, string>()
      for (const run of dag.runs) {
        for (const node of run.nodes) {
          if (node.taskId === undefined || isTerminalDagState(node.state) || activity.has(node.taskId)) continue
          const text = readTaskActivity(options.stateDir, node.taskId)
          if (text !== undefined) activity.set(node.taskId, text)
        }
      }
      return {
        items: projectTaskTree(snapshot.records, { runs: dag.runs, activity }),
        invalidRecords: snapshot.invalidRecords + dag.invalidRuns,
      }
    } catch (error) {
      return { items: [], invalidRecords: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const loadTarget = (current: ViewerState, items: readonly TaskTreeItem[]): TargetLoad => {
    const target = targetFor(current, items)
    if (target === undefined) return { transcript: EMPTY_TRANSCRIPT }
    try {
      return { transcript: target.read(), key: target.key }
    } catch (error) {
      return { transcript: EMPTY_TRANSCRIPT, key: target.key, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const renderFrame = (): void => {
    const viewport = measure()
    let next = projectViewer(state, data, viewport)
    if (focusSelection && next.focusOffset !== undefined) {
      state = { ...state, scrollOffset: next.focusOffset }
      next = projectViewer(state, data, viewport)
    }
    focusSelection = false
    const clamped = clampViewer(state, next.limits)
    if (clamped !== state) {
      state = clamped
      next = projectViewer(state, data, viewport)
    }
    frame = next
    const todoVisible = frame.todo !== undefined
    todoPanel.visible = todoVisible
    todoPanel.height = todoVisible ? (frame.todo?.lines.length ?? 0) + 4 : 0
    todoText.content = todoVisible && frame.todo !== undefined ? paneContent(frame.todo) : ""
    const terminalsVisible = frame.terminals !== undefined
    terminalsPanel.visible = terminalsVisible
    terminalsPanel.height = terminalsVisible ? (frame.terminals?.lines.length ?? 0) + 4 : 0
    terminalsText.content = terminalsVisible && frame.terminals !== undefined ? paneContent(frame.terminals) : ""
    listPanel.borderColor = state.focus === "tree" ? RAIL_COLOR : "#34405e"
    detailPanel.borderColor = state.focus === "transcript" ? RAIL_COLOR : "#34405e"
    todoPanel.borderColor = state.focus === "todo" ? RAIL_COLOR : "#34405e"
    header.content = frame.header
    footer.content = frame.footer
    listText.content = paneContent(frame.list)
    detailText.content = paneContent(frame.detail)
    listText.scrollY = 0
    detailText.scrollY = 0
    renderer.requestRender()
  }

  const scheduleRender = (): void => {
    if (scheduled || closed) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      if (!closed) renderFrame()
    })
  }
  listText.onSizeChange = scheduleRender
  detailText.onSizeChange = scheduleRender

  const reload = (force = false): void => {
    if (closed) return
    if (state.paused && !force) return
    const store = loadStore()
    state = reconcileViewer(state, store.items)
    const loaded = loadTarget(state, store.items)
    state = reconcileViewer(state, store.items, loaded.transcript)
    data = {
      items: store.items,
      transcript: loaded.transcript,
      projectDir: options.projectDir,
      refreshMs: options.refreshMs,
      invalidRecords: store.invalidRecords,
      error: store.error ?? loaded.error,
    }
    dataTargetKey = loaded.key
    renderFrame()
  }

  const dispatch = (input: ViewerInput): void => {
    const previousTurn = state.selectedTurnId
    state = updateViewer(state, input, context())
    focusSelection = state.selectedTurnId !== previousTurn && state.selectedTurnId !== undefined
    const target = targetFor(state, data.items)
    if (target === undefined) {
      state = reconcileViewer(state, data.items, EMPTY_TRANSCRIPT)
      data = { ...data, transcript: EMPTY_TRANSCRIPT }
      dataTargetKey = undefined
    } else if (target.key !== dataTargetKey) {
      const loaded = loadTarget(state, data.items)
      state = reconcileViewer(state, data.items, loaded.transcript)
      data = { ...data, transcript: loaded.transcript, error: loaded.error }
      dataTargetKey = loaded.key
    }
    renderFrame()
  }

  const shutdown = (): void => {
    if (closed) return
    closed = true
    clearInterval(timer)
    renderer.destroy()
  }

  const scrollPage = (direction: "older" | "newer"): void => {
    const sign = direction === "older" ? -1 : 1
    if (state.focus === "tree") {
      const rows = frame?.list.lines.length ?? 10
      dispatch({ type: "move-selection", delta: sign * Math.max(1, Math.floor((rows - 1) / 2)) })
      return
    }
    const rows = state.focus === "todo" ? frame?.todo?.lines.length : frame?.detail.lines.length
    dispatch({ type: "scroll-transcript", direction, amount: Math.max(1, (rows ?? 10) - 1) })
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") return shutdown()
    if (key.name === "q") return shutdown()
    if (key.name === "up") return dispatch({ type: "move", delta: -1 })
    if (key.name === "down") return dispatch({ type: "move", delta: 1 })
    if (key.name === "pageup") return scrollPage("older")
    if (key.name === "pagedown") return scrollPage("newer")
    if (key.name === "return" || key.name === "enter" || key.name === "right") return dispatch({ type: "open" })
    if (key.name === "o") {
      if (state.focus === "tree" && state.selectedId !== undefined) dispatch({ type: "open-item", id: state.selectedId })
      return
    }
    if (key.name === "left") return dispatch({ type: "exit-level" })
    if (key.name === "escape") return dispatch({ type: "back" })
    if (key.name === "t") return dispatch({ type: "toggle-turn" })
    if (key.name === "tab") return dispatch({ type: "cycle-focus" })
    if (key.name === "1") return dispatch({ type: "toggle-filter", filter: "completed" })
    if (key.name === "2") return dispatch({ type: "toggle-filter", filter: "running" })
    if (key.name === "3") return dispatch({ type: "toggle-filter", filter: "stopped" })
    if (key.name === "4") return dispatch({ type: "toggle-todo-done" })
    if (key.name === "l") return dispatch({ type: "toggle-todo" })
    if (key.name === "m") return dispatch({ type: "toggle-terminals" })
    if (key.name === "j") return dispatch({ type: "scroll-transcript", direction: "newer", amount: 1 })
    if (key.name === "k") return dispatch({ type: "scroll-transcript", direction: "older", amount: 1 })
    if (key.name === "g") return dispatch({ type: "follow" })
    if (key.name === "p") return dispatch({ type: "toggle-pause" })
    if (key.name === "r") {
      state = updateViewer(state, { type: "set-paused", paused: false }, context())
      reload(true)
    }
  })

  const rowAt = (text: TextRenderable, screenY: number): number | undefined => {
    const row = screenY - text.screenY
    return row >= 0 ? row : undefined
  }

  listPanel.onMouseDown = (event) => {
    if (event.button !== 0) return
    const row = rowAt(listText, event.y)
    const hit = row === undefined ? undefined : frame?.list.hits[row]
    if (hit?.kind === "item") dispatch({ type: "open-item", id: hit.id })
  }

  detailPanel.onMouseDown = (event) => {
    if (event.button !== 0) return
    const row = rowAt(detailText, event.y)
    const hit = row === undefined ? undefined : frame?.detail.hits[row]
    if (hit?.kind === "turn") dispatch({ type: "expand-turn", id: hit.id })
  }

  listPanel.onMouseScroll = (event) => {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    const step = scrollStep(event)
    dispatch({ type: "move-selection", delta: direction === "up" ? -step : step })
  }

  detailPanel.onMouseScroll = (event) => {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    const step = scrollStep(event)
    dispatch({ type: "scroll-transcript", direction: direction === "up" ? "older" : "newer", amount: step })
  }

  todoPanel.onMouseDown = () => dispatch({ type: "set-focus", focus: "todo" })

  todoPanel.onMouseScroll = (event) => {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    if (state.focus !== "todo") dispatch({ type: "set-focus", focus: "todo" })
    const step = scrollStep(event)
    dispatch({ type: "scroll-transcript", direction: direction === "up" ? "older" : "newer", amount: step })
  }

  const timer = setInterval(() => reload(), options.refreshMs)
  reload(true)
}

function scrollStep(event: { readonly scroll?: { readonly delta: number } }): number {
  return Math.max(1, Math.min(5, Math.abs(event.scroll?.delta ?? 1)))
}

type Chunk = { readonly __isChunk: true; readonly text: string; readonly fg?: RGBA; readonly bg?: RGBA }

export function paneContent(pane: PaneFrame): StyledText {
  const chunks: Chunk[] = []
  pane.lines.forEach((line, index) => {
    if (index > 0) chunks.push({ __isChunk: true, text: "\n" })
    const style = pane.styles?.[index]
    if (style?.rail === true) {
      chunks.push({ __isChunk: true, text: "  ", bg: RGBA.fromHex(style.railColor ?? RAIL_COLOR) })
    }
    const cells = pane.cells?.[index]
    if (cells === undefined) {
      chunks.push(styledChunk(line, style))
      return
    }
    for (const cell of cells) {
      chunks.push(cellChunk(cell))
    }
  })
  return new StyledText(chunks)
}

function cellChunk(cell: PreviewCell): Chunk {
  let chunk: Chunk = {
    __isChunk: true,
    text: cell.text,
    ...(cell.fg === undefined ? {} : { fg: RGBA.fromHex(cell.fg) }),
    ...(cell.bg === undefined ? {} : { bg: RGBA.fromHex(cell.bg) }),
  }
  if (cell.bold === true) chunk = bold(chunk)
  if (cell.dim === true) chunk = dim(chunk)
  return chunk
}

function styledChunk(text: string, style: RowStyle | undefined): Chunk {
  let chunk: Chunk = {
    __isChunk: true,
    text,
    ...(style?.fg === undefined ? {} : { fg: RGBA.fromHex(style.fg) }),
    ...(style?.bg === undefined ? {} : { bg: RGBA.fromHex(style.bg) }),
  }
  if (style?.bold === true) chunk = bold(chunk)
  if (style?.dim === true) chunk = dim(chunk)
  return chunk
}
