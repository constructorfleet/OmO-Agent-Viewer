import { describe, expect, test } from "bun:test"

import {
  buildTranscriptDocument,
  formatSessionTranscript,
  formatTurnBody,
  parseEventErrors,
  parseEventTranscript,
  parseSessionTurns,
  parseTodoReport,
  summarizeTurn,
  type TranscriptTurn,
} from "../src/transcript"

const assistant = (id: string, content: unknown[]): string =>
  JSON.stringify({ id, type: "message", message: { role: "assistant", content } })

const toolResult = (toolCallId: string, toolName: string, text: string, isError = false): string =>
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] },
  })

const toolResultWithDetails = (
  toolCallId: string,
  toolName: string,
  text: string,
  details: unknown,
): string =>
  JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: false,
      content: [{ type: "text", text }],
      details,
    },
  })

describe("parseEventTranscript", () => {
  test("#given task event JSONL #when parsed #then assistant, tool and error activity is readable", () => {
    const text = [
      JSON.stringify({ type: "assistant_message", payload: { text: "I found the bug." } }),
      JSON.stringify({ type: "tool_execution", payload: { tool: "read" } }),
      JSON.stringify({ type: "child_error", payload: { message: "permission denied" } }),
    ].join("\n")

    expect(parseEventTranscript(text)).toEqual([
      "assistant: I found the bug.",
      "tool: read",
      "error: permission denied",
    ])
  })

  test("#given a partial final JSONL line #when parsed #then it ignores that write in progress", () => {
    const text = `${JSON.stringify({ type: "assistant_message", payload: { text: "complete" } })}\n{"type":"assistant_message","payload":{"text":"still writing`
    expect(parseEventTranscript(text)).toEqual(["assistant: complete"])
  })

  test("#given malformed and future event rows #when parsed #then it keeps valid known rows", () => {
    const text = [
      "not json",
      JSON.stringify({ type: "future_event", payload: {} }),
      JSON.stringify({ type: "assistant_message", payload: { text: "still here" } }),
    ].join("\n")
    expect(parseEventTranscript(text)).toEqual(["assistant: still here"])
  })
})

describe("parseEventErrors", () => {
  test("#given event rows #when parsed for errors #then it returns child error messages without display prefixes", () => {
    const text = [
      JSON.stringify({ type: "child_error", payload: { message: "permission denied" } }),
      JSON.stringify({ type: "child_error", payload: { message: "permission denied" } }),
      JSON.stringify({ type: "assistant_message", payload: { text: "still here" } }),
    ].join("\n")
    expect(parseEventErrors(text)).toEqual(["permission denied", "permission denied"])
  })
})

describe("parseSessionTurns", () => {
  test("#given assistant calls and results #when parsed into turns #then each result stays with its call's turn", () => {
    const text = [
      assistant("turn-a", [
        { type: "thinking", thinking: "Need the config." },
        { type: "text", text: "Reading it." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/config.json" } },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "bun test" } },
      ]),
      toolResult("call-2", "bash", "1 fail", true),
      assistant("turn-b", [{ type: "text", text: "Done." }]),
    ].join("\n")

    const turns = parseSessionTurns(text)
    expect(turns.map((turn) => turn.id)).toEqual(["turn-a", "turn-b"])
    expect(turns[0]?.thinking).toEqual(["Need the config."])
    expect(turns[0]?.parts).toEqual([
      { kind: "text", text: "Reading it." },
      { kind: "call", call: { id: "call-1", name: "read", arguments: { path: "/tmp/config.json" } } },
      { kind: "call", call: { id: "call-2", name: "bash", arguments: { command: "bun test" } } },
    ])
    expect(turns[0]?.results).toEqual([{ callId: "call-2", name: "bash", isError: true, text: "1 fail" }])
  })

  test("#given a tool result with an image part #when parsed #then the image stays with its turn and out of the text lines", () => {
    const text = [
      assistant("turn-a", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/shot.png" } }]),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", mimeType: "image/png", data: "cG5nLWJ5dGVz" },
          ],
        },
      }),
    ].join("\n")

    const turns = parseSessionTurns(text)
    expect(turns[0]?.results[0]?.images).toEqual([{ mimeType: "image/png", data: "cG5nLWJ5dGVz" }])
    const document = buildTranscriptDocument(turns)
    expect(document.lines).toEqual([
      'tool: read path="/tmp/shot.png"',
      "result(read): Read image file [image/png] [1 image]",
    ])
    expect(document.lines.join("\n")).not.toContain("cG5nLWJ5dGVz")
  })

  test("#given todo calls batched inside eval #when parsed #then the checklist comes from the nested details", () => {
    const text = [
      assistant("turn-a", [{ type: "toolCall", id: "call-eval", name: "eval", arguments: { code: "await tool.todo(...)" } }]),
      toolResultWithDetails("call-eval", "eval", "TODO started", {
        toolCalls: [
          { name: "read", ok: true, args: { path: "/tmp/plan.md" } },
          {
            name: "todo",
            ok: true,
            args: { op: "start", task: "Build the widget" },
            details: {
              op: "start",
              storage: "session",
              phases: [
                {
                  name: "Wave 1",
                  tasks: [
                    { content: "Read the code", status: "completed" },
                    { content: "Build the widget", status: "in_progress" },
                  ],
                },
                {
                  name: "Wave 2",
                  tasks: [
                    { content: "Drop the old path", status: "abandoned" },
                    { content: "Test the widget", status: "pending" },
                  ],
                },
              ],
            },
          },
        ],
      }),
    ].join("\n")

    const turns = parseSessionTurns(text)
    expect(turns[0]?.results[0]?.todo).toEqual({
      done: 2,
      total: 4,
      open: 2,
      now: "Build the widget (Wave 1)",
      next: "Test the widget (Wave 2)",
      activePhase: "Wave 1",
      phases: [
        {
          name: "Wave 1",
          items: [
            { text: "Read the code", status: "completed" },
            { text: "Build the widget", status: "in_progress" },
          ],
        },
        {
          name: "Wave 2",
          items: [{ text: "Test the widget", status: "pending" }],
        },
      ],
      remaining: [
        { text: "Build the widget", status: "in_progress" },
        { text: "Test the widget", status: "pending" },
      ],
    })
  })
})

describe("formatSessionTranscript", () => {
  const text = [
    assistant("turn-a", [
      { type: "thinking", thinking: "**Check**\n\nNeed the file first." },
      { type: "text", text: "Reading the file." },
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "/tmp/example.txt", offset: 1 } },
      { type: "toolCall", id: "call-todo", name: "todo", arguments: { op: "start" } },
    ]),
    toolResult("call-read", "read", "line one\nline two\nline three"),
    toolResult("call-todo", "todo", "checklist"),
  ].join("\n")

  test("#given session tool activity #when formatted with detail #then it shows arguments and result previews", () => {
    expect(formatSessionTranscript(parseSessionTurns(text), { toolDetail: true, thinkingPreview: true })).toEqual([
      "thinking: **Check** Need the file first.",
      "assistant: Reading the file.",
      'tool: read path="/tmp/example.txt"',
      "tool: todo op=\"start\"",
      "result(read): line one (3 lines)",
    ])
  })

  test("#given session tool activity #when formatted without detail #then only assistant text is returned", () => {
    expect(formatSessionTranscript(parseSessionTurns(text))).toEqual(["assistant: Reading the file."])
  })

  test("#given long tool arguments #when formatted #then paths keep their informative tail", () => {
    const path = `/very/long/prefix/${"nested/".repeat(30)}target.ts`
    const [line] = formatSessionTranscript(
      parseSessionTurns(assistant("turn-a", [{ type: "toolCall", name: "read", arguments: { path } }])),
      { toolDetail: true },
    )
    expect(line).toEndWith('target.ts"')
    expect(line).toContain("...")
    expect(line!.length).toBeLessThan(140)
  })
})

describe("parseTodoReport", () => {
  const report = [
    "Ask: Ship the widget",
    "Now: Build the widget (Build)",
    "Next: Test the widget (Verify)",
    "",
    "Remaining items (2):",
    "  - Build the widget [in_progress] (Build)",
    "  - Test the widget [pending] (Verify)",
    "Overall: 1/3 done, 2 open.",
    'Active phase 1/2 "Build" (0/2).',
    "  Setup:",
    "    - [X] Read the code",
    "  Build:",
    "    - [ ] Build the widget (in progress)",
    "    - [ ] Test the widget",
  ].join("\n")

  test("#given a rendered todo report #when parsed #then counts, now/next, phases and item statuses are kept", () => {
    const todo = parseTodoReport(report)
    expect(todo).toMatchObject({
      done: 1,
      total: 3,
      open: 2,
      now: "Build the widget (Build)",
      next: "Test the widget (Verify)",
      activePhase: "Build",
      remaining: [
        { text: "Build the widget", status: "in_progress" },
        { text: "Test the widget", status: "pending" },
      ],
    })
    expect(todo?.phases).toEqual([
      { name: "Setup", items: [{ text: "Read the code", status: "completed" }] },
      {
        name: "Build",
        items: [
          { text: "Build the widget", status: "in_progress" },
          { text: "Test the widget", status: "pending" },
        ],
      },
    ])
  })

  test("#given unrelated text #when parsed as a todo report #then it returns nothing", () => {
    expect(parseTodoReport("assistant: hello")).toBeUndefined()
  })
})

describe("buildTranscriptDocument", () => {
  test("#given a session whose last todo result is followed by other work #when built #then the document carries that checklist", () => {
    const todoText = "Now: Step (Phase)\n\nRemaining items (1):\n  - Step [in_progress] (Phase)\nOverall: 0/1 done, 1 open.\nActive phase 1/1 \"Phase\" (0/1).\n  Phase:\n    - [ ] Step (in progress)"
    const turns: TranscriptTurn[] = [
      {
        id: "turn-a",
        thinking: [],
        parts: [],
        results: [{ name: "todo", isError: false, text: todoText }],
      },
      { id: "turn-b", thinking: [], parts: [{ kind: "text", text: "done" }], results: [] },
    ]
    const document = buildTranscriptDocument(turns)
    expect(document.todo).toMatchObject({ done: 0, total: 1, open: 1, activePhase: "Phase" })
    expect(document.lines).toEqual(["assistant: done"])
  })

  test("#given a main session whose newest todo is nested in eval #when built #then the document carries it", () => {
    const text = [
      assistant("turn-a", [{ type: "toolCall", id: "call-eval", name: "eval", arguments: {} }]),
      toolResultWithDetails("call-eval", "eval", "TODO started", {
        toolCalls: [
          {
            name: "todo",
            ok: true,
            args: { op: "start", task: "Step" },
            details: {
              op: "start",
              phases: [{ name: "Phase", tasks: [{ content: "Step", status: "in_progress" }] }],
            },
          },
        ],
      }),
      assistant("turn-b", [{ type: "text", text: "still working" }]),
    ].join("\n")

    const document = buildTranscriptDocument(parseSessionTurns(text))
    expect(document.todo).toMatchObject({
      done: 0,
      total: 1,
      open: 1,
      now: "Step (Phase)",
      activePhase: "Phase",
    })
    expect(document.lines).toEqual([
      "tool: eval",
      "result(eval): TODO started",
      "assistant: still working",
    ])
  })

  test("#given turns and errors #when built #then every line names its turn and errors stay unattached", () => {
    const turn: TranscriptTurn = {
      id: "turn-a",
      thinking: ["Need context."],
      parts: [{ kind: "call", call: { name: "read", arguments: { path: "/tmp/file" } } }],
      results: [],
    }
    const document = buildTranscriptDocument([turn], ["provider failed"])
    expect(document.lines).toEqual([
      "thinking: Need context.",
      'tool: read path="/tmp/file"',
      "error: provider failed",
    ])
    expect(document.lineTurns).toEqual(["turn-a", "turn-a", undefined])
    expect(document.turns).toEqual([turn])
  })
})

describe("summarizeTurn", () => {
  test("#given a turn with calls and thinking #when summarized #then it names the calls and previews the thought", () => {
    const turn: TranscriptTurn = {
      id: "turn-a",
      thinking: ["Need the config."],
      parts: [
        { kind: "call", call: { name: "read", arguments: {} } },
        { kind: "call", call: { name: "bash", arguments: {} } },
      ],
      results: [],
    }
    expect(summarizeTurn(turn)).toBe("2 calls: read, bash · Need the config.")
  })
})

describe("formatTurnBody", () => {
  test("#given a turn #when formatted for inspection #then thoughts and full arguments are shown", () => {
    const path = `/tmp/${"nested/".repeat(30)}config.json`
    const turn: TranscriptTurn = {
      id: "turn-a",
      thinking: ["Need to inspect the config."],
      parts: [
        { kind: "text", text: "Reading it." },
        { kind: "call", call: { name: "read", arguments: { path, offset: 1 } } },
      ],
      results: [{ name: "read", isError: false, text: "ok" }],
    }

    const lines = formatTurnBody(turn)
    expect(lines).toContain("THINKING")
    expect(lines).toContain("  Need to inspect the config.")
    expect(lines).toContain("CALL read")
    expect(lines).toContain("  path:")
    expect(lines).toContain(`    ${path}`)
    expect(lines).toContain("  result(read): ok")
  })
})
