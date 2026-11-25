import { spawnSync } from "node:child_process"
import { basename } from "node:path"

export interface TmuxPlanOptions {
  readonly projectDir: string
  readonly sessionName: string
  readonly omoArgs: readonly string[]
  readonly viewerCommand: readonly string[]
  readonly insideTmux: boolean
}

export type TmuxCommand = readonly string[]
export type TmuxPlan = readonly TmuxCommand[]

export function buildTmuxPlan(options: TmuxPlanOptions): TmuxPlan {
  const targetWindow = `${options.sessionName}:omo`
  const commands: TmuxCommand[] = [
    [
      "new-session",
      "-d",
      "-s",
      options.sessionName,
      "-n",
      "omo",
      "-c",
      options.projectDir,
      shellCommand(["omo", ...options.omoArgs]),
    ],
    // Session-scoped, so the terminal tab names this project only while this session is shown.
    ["set-option", "-t", options.sessionName, "set-titles", "on"],
    ["set-option", "-t", options.sessionName, "set-titles-string", tmuxLiteral(terminalTitle(options.projectDir))],
    [
      "split-window",
      "-h",
      "-t",
      targetWindow,
      "-c",
      options.projectDir,
      shellCommand(options.viewerCommand),
    ],
    ["select-pane", "-l", "-t", targetWindow],
    options.insideTmux
      ? ["switch-client", "-t", options.sessionName]
      : ["attach-session", "-t", options.sessionName],
  ]
  return commands
}

export type TmuxRunner = (args: TmuxCommand) => { readonly status: number | null; readonly error?: Error }

export function runTmuxPlan(plan: TmuxPlan, runner: TmuxRunner = runTmux): void {
  for (const args of plan) {
    const result = runner(args)
    if (result.error !== undefined) throw new Error(`Could not run tmux: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`tmux ${args[0]} failed${result.status === null ? "" : ` (exit ${result.status})`}`)
  }
}

function runTmux(args: TmuxCommand): { readonly status: number | null; readonly error?: Error } {
  const result = spawnSync("tmux", [...args], { stdio: "inherit" })
  return {
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

export function terminalTitle(projectDir: string): string {
  return `${basename(projectDir) || projectDir} · omo`
}

/** `set-titles-string` is a tmux format; `##` keeps a literal `#` in a project name. */
function tmuxLiteral(value: string): string {
  return value.replaceAll("#", "##")
}

function shellCommand(parts: readonly string[]): string {
  return `exec ${parts.map(shellQuote).join(" ")}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
