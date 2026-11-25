import { describe, expect, test } from "bun:test"

import { buildTmuxPlan, runTmuxPlan } from "../src/wrapper"

describe("tmux wrapper plan", () => {
  test("#given an OmO launch and project with spaces #when building a plan #then it opens OmO and viewer panes in that project", () => {
    const plan = buildTmuxPlan({
      projectDir: "/work/my project",
      sessionName: "omo-agents-42",
      omoArgs: ["--resume", "session id"],
      viewerCommand: ["bun", "/app/main.js", "--project", "/work/my project"],
      insideTmux: true,
    })

    expect(plan).toEqual([
      ["new-session", "-d", "-s", "omo-agents-42", "-n", "omo", "-c", "/work/my project", "exec 'omo' '--resume' 'session id'"],
      ["set-option", "-t", "omo-agents-42", "set-titles", "on"],
      ["set-option", "-t", "omo-agents-42", "set-titles-string", "my project · omo"],
      ["split-window", "-h", "-t", "omo-agents-42:omo", "-c", "/work/my project", "exec 'bun' '/app/main.js' '--project' '/work/my project'"],
      ["select-pane", "-l", "-t", "omo-agents-42:omo"],
      ["switch-client", "-t", "omo-agents-42"],
    ])
  })

  test("#given a shell argument with quotes #when building the pane command #then it is passed literally", () => {
    const plan = buildTmuxPlan({
      projectDir: "/tmp",
      sessionName: "omo-agents-42",
      omoArgs: ["say 'hello'"],
      viewerCommand: ["bun", "main.js"],
      insideTmux: false,
    })
    expect(plan[0]?.at(-1)).toBe(String.raw`exec 'omo' 'say '\''hello'\'''`)
    expect(plan.at(-1)).toEqual(["-L", "omo-agents-42", "attach-session", "-t", "omo-agents-42"])
  })

  test("#given a launch outside tmux #when building a plan #then every command targets a server of its own", () => {
    const plan = buildTmuxPlan({
      projectDir: "/tmp",
      sessionName: "omo-agents-9",
      omoArgs: [],
      viewerCommand: ["bun", "main.js"],
      insideTmux: false,
    })
    expect(plan.every((command) => command[0] === "-L" && command[1] === "omo-agents-9")).toBe(true)
  })

  test("#given a project name with a hash #when setting the tab title #then tmux receives it as a literal", () => {
    const plan = buildTmuxPlan({
      projectDir: "/work/issue#12",
      sessionName: "omo-agents-1",
      omoArgs: [],
      viewerCommand: ["bun", "main.js"],
      insideTmux: true,
    })
    expect(plan).toContainEqual(["set-option", "-t", "omo-agents-1", "set-titles-string", "issue##12 · omo"])
  })

  test("#given a tmux command runner #when executing the plan #then every pane and attach command is dispatched in order", () => {
    const plan = buildTmuxPlan({
      projectDir: "/tmp/project",
      sessionName: "omo-agents-7",
      omoArgs: [],
      viewerCommand: ["bun", "main.js"],
      insideTmux: false,
    })
    const calls: string[][] = []

    runTmuxPlan(plan, (args) => {
      calls.push([...args])
      return { status: 0 }
    })

    expect(calls).toEqual(plan)
  })
})
