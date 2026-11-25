# OmO Agent Viewer

A small, read-only terminal companion for browsing OmO Native delegated tasks and following their transcripts.

This is a separate project from `oh-my-openagent`. Its code, dependencies, Git history, and build output live outside the upstream checkout, so replacing or upgrading that checkout cannot overwrite the viewer. It reads the task store on disk and does not patch or import upstream code.

## Requirements

- Bun 1.3.14 or newer
- OmO Native with task records enabled

## Run

From this directory:

```sh
bun install
bun run build
bun run start
```

To install the `omo-agents` command globally, run `bun add --global .` from this directory. Then run it inside an OmO project; the default project is the current directory. (`bun link --global` only registers this package so projects can link it as a dependency.)

```sh
omo-agents --project ~/src/my-project
omo-agents --project ~/src/my-project --state-dir /path/to/senpi-task
omo-agents --wrap -- -c
```

`--wrap` starts OmO and the viewer in side-by-side tmux panes, focused on OmO. Use tmux's pane switch shortcut (default `Ctrl-b`, then `o`) to move to the viewer and back. Arguments after `--` are passed to `omo`; omit them to start a new session. The terminal tab is titled with the project name. When run inside tmux, the wrapper switches to the new split session; otherwise it starts the session on a tmux server of its own (socket named after the session) and attaches to it, so several wrapped tabs do not slow each other's redraws. To reattach after detaching, run `tmux -L <session> attach`; `tmux -L <session> ls` lists it.

The viewer discovers the configured OmO Native agent directory and falls back to the legacy in-project `.omo/senpi-task` store when it contains task records. Use `--state-dir` if the store is somewhere else.

## Keys

- `↑` / `↓`: select a main session or task; with the turn list focused, step between turns; with the todo pane focused, scroll it
- `PageUp` / `PageDown`: page through the focused pane: move the task list selection, or scroll the transcript or todo pane
- `Enter` / `→`: expand or collapse the selected main session in the tree; on an agent row, open its turn list with the newest turn selected; with the turn list focused, open the selected turn's detail inline (run headers have no transcript, so they only select)
- `o`: open the selected main session or agent transcript without changing tree expansion
- `←`: back one level (close the turn detail, then return focus to the task list)
- `Esc`: close the expanded turn, then return to the main session
- `Tab`: move focus between the task list, the transcript, and the todo pane
- `1` / `2` / `3`: hide or show completed, running (running and queued), and stopped (paused, cancelled, interrupted) tasks
- `t`: open the newest turn's detail inline in the transcript (thinking, exact tool arguments, results); press again to close it
- `l`: show or hide the todo pane
- `m`: show or hide the monitors and background-shell pane
- `4`: hide or show completed todo items
- `j` / `k`: scroll the focused pane (the transcript, or the todo pane when it has focus)
- `g`: jump to the latest transcript output, and to the newest turn when one is expanded
- `p`: pause or resume refresh
- `r`: refresh now
- `q`: quit

An expanded turn is drawn inside the transcript, right after its own lines, and the view recenters on it as you step from turn to turn; `j` / `k` scroll the same transcript. Expanding a turn never hides the conversation around it. The turn list cursor marks the selected turn with a left rail and a tinted row background even before its detail is open, and the footer names the open turn as `TURN 3 / 12`, so the pointer stays visible even after scrolling away. The rail is blue in the pane you are driving; the other pane keeps its selection with a gray rail, and the focused pane's border turns blue.

When the agent uses the todo tool, a todo pane sits under the task list at the same width: `TODO 4/15` with the `Now` and `Next` lines, then every phase with its progress and items (`✓` done, `●` in progress, `○` pending). The pane comes from the last todo tool result in the loaded session window and sizes itself to the list up to about a third of the screen; when the list is longer, completed items drop first and the pane scrolls with `↑` / `↓` (or `j` / `k`) once `Tab` focuses it, showing its row range at the bottom. `4` hides completed items, and `l` hides or shows the pane.

A `MONITORS / SHELLS` pane sits under the transcript for the session being viewed, showing the harness watches that keep an agent awake: `monitor` watches (`◉`) and background `bash` PTYs (`▣`), each with its id, `open` or `passive` state, age, persistence or timeout, description, and the monitor's filter. It is built from the last `work-custody` record per wake source in the session file, joined to the `monitor` / `bash` call that launched it, so a watch whose launch scrolled out of the read window still lists its id and description. `open` means the session is parked on that watch; `passive` means it is registered while the session works elsewhere. A session that is already done or paused keeps its final record, so the pane labels those rows as possibly stale. `m` hides or shows the pane.

Main sessions start collapsed behind `▸`; `Enter` opens one (`▾`) and reveals its agent rows with tree branches, including nested subagents at any depth, and each main expands independently. Runs from the OmO DAG status log nest under their main session as header rows, newest first: `▶ Omo-daemonic Wave 2: Todos 5,... running wave 1/2 0/6 done, 3 running`, followed by their nodes with route (`category:deep-high` or `agent:name(model)`), the latest assistant activity for running nodes, and elapsed or `waiting` time. Tasks that belong to a run appear under its header instead of loose in the tree; nodes that have not started yet still get a pending row. A run header is organizational, so selecting it only highlights the group and leaves the transcript unchanged. A collapsed main is a single row, so a store with dozens of agents stays navigable; the list window follows the cursor with `↑ more above` / `↓ more below`, and selecting an agent keeps its main expanded. `o` opens the selected main session's transcript, which `Enter` cannot do while it is toggling expansion.

Transcript rows are colored by kind: assistant text blue, thinking gray and dim, tool calls amber, results green, errors red. The tree colors each task by status (running amber, done green, failed/lost red); the selected task gets a bright left rail and a tinted pair of rows, matching the turn cursor. Filters are shown after the tree title (for example `–completed`) and filtered tasks never swallow the selected or viewed task, which stays visible. Run headers always stay visible; filters apply to the DAG nodes below them.

When the agent reads or inspects an image, the expanded turn shows that image as a half-block preview with its pixel size and MIME type (up to three images per turn). Previews are colored `▀` cells, so they work in any terminal, inside tmux, and without kitty or sixel support.

Mouse: the wheel scrolls the tree or the open transcript. Click a task in the tree to open it, click a run header to select it, or click any line in a session or agent transcript to expand that turn inline; click it again to close.

The task list follows the selected row as you move with `↑` / `↓`. The main-session view uses the same transcript detail and inline turn expansion as agent views, including root-session turns; `j` / `k` scroll either root or agent output. In wrap mode, switch to the OmO pane and use `/task-kill` to choose and cancel a task.

The viewer refreshes task records and the viewed transcript document on the refresh interval, then renders from the loaded document without doing I/O. Set `--refresh-ms` from 250 to 10000 to change the interval; `p` pauses reads and `r` resumes and reloads immediately. It only reads task-store and session files. To cancel a task, use OmO's `/task-kill` command in the owning OmO session; the external terminal control API does not expose task-specific cancellation.

Reads stay bounded: the viewer reads at most the last 4 MiB of the selected root or child session per file (at most the first and last file when a task has several), plus the small per-task event log. For DAG node activity it reads only the last 8 KiB of each running task's event log and shows the newest assistant message. Set `--read-bytes` from 65536 to 67108864 to trade memory and parse time for more history. It never loads a whole conversation, and turn expansion works on that same tail window. Images are stored inline in those session entries as base64, so a preview appears only when the entry fits inside the read window; raise `--read-bytes` to reach older or larger images. Decoded previews are cached by content and the base64 payload is never rendered as text.

## Development

```sh
bun test
bun run build
```

The code is split into a pure viewer model (interaction state and pane projection), a task-store module (layout, records, DAG runs, activity, and transcript documents), transcript parsing/formatting, and a thin OpenTUI adapter. Tests cross the model and store interfaces rather than driving the terminal.

The task-store layout is discovered from OmO Native's `senpi-task` store. If upstream changes that on-disk layout, adjust the standalone reader or pass the new location with `--state-dir`; upgrading the upstream source will not overwrite this project.
