# Noidisbo

Creating my own note-taking app like Obsidian.

Noidisbo is a local-first Markdown notes app for the desktop. Notes are plain `.md` files in a folder you own; the app adds linking, backlinks, a graph view and a live-preview editor on top. It is written from scratch in Electron and TypeScript and shares no code with Obsidian.

## Features

- **Vault of plain files**: any folder of Markdown files works. Nothing is stored in a proprietary format.
- **Wikilinks**: `[[Note]]`, `[[Note|label]]` and `[[Note#heading]]`, with autocomplete when you type `[[`. Following a link to a note that doesn't exist creates it.
- **Backlinks and outline**: a side panel shows which notes link to the current one, and its headings.
- **Graph view**: every note is a dot, every link a line. Drag, zoom, click to open.
- **Three editing modes**:
  - *Live* renders Markdown in place and shows raw syntax only around the cursor.
  - *Source* shows raw Markdown.
  - *Read* is a fully rendered, read-only view.
- **Quick switcher, search and tags**: jump to or create a note by name, search all note text, browse `#tags`.
- **Folder management**: create, rename, trash and drag-and-drop notes and folders. Links are rewritten when their target is renamed or moved.
- **Themes**: Dark, Solarized Dark and Dracula.
- **Live sync with disk**: files changed by other programs show up immediately.

## Getting started

Requirements: Node.js 20 or newer, and npm. Development has been on macOS (Apple silicon); other platforms are untested.

```bash
npm install
npm run dev
```

On first launch choose **Open a folder** and pick a vault. The `sample-vault` folder in this repository is a small one to try.

To start directly in a particular vault, set `NOIDISBO_VAULT`:

```bash
NOIDISBO_VAULT="$PWD/sample-vault" npm run dev
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with live reload of the interface |
| `npm run build` | Compile everything into `out/` |
| `npm run start` | Run the compiled build from `out/` |
| `npm run typecheck` | Type-check the whole project |
| `npm run dist` | Build `Noidisbo.app` and a `.dmg` into `dist/` |

### Building the installable app

```bash
npm run dist
```

This produces `dist/mac-arm64/Noidisbo.app` and `dist/Noidisbo-<version>-arm64.dmg`. The app is signed locally (ad hoc), not by Apple, so it runs on the Mac that built it but shows an "unidentified developer" warning elsewhere. The icon comes from `build/icon.png`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Cmd+O or Cmd+P | Find or create a note |
| Cmd+N | New note in the current note's folder |
| Cmd+E | Switch between Live and Read |
| Cmd+G | Graph view |
| Cmd+Shift+F | Search all notes |
| Cmd+F | Find within the current note |
| Cmd+B / Cmd+I | Bold / italic |
| Cmd+click on a link | Follow it (in Live mode a plain click is enough) |

On Windows and Linux, use Ctrl in place of Cmd.

## The vault

A vault is an ordinary folder. Noidisbo reads it; it does not own it.

- **What counts as a note**: every file ending in `.md`, in the vault folder or any subfolder. Other file types are ignored.
- **What is skipped**: files and folders whose names start with a dot (such as `.git` or `.obsidian`), and `node_modules`.
- **Note names**: a note's name is its file name without `.md`. Renaming the note renames the file.
- **No hidden data**: Noidisbo writes nothing into the vault except your notes. There is no index, cache or settings folder inside it.
- **Where settings live**: the last opened vault is remembered in `state.json` in the app's user-data folder (`~/Library/Application Support/noidisbo` on macOS). The theme choice is kept in the app's own browser storage.
- **Saving**: edits are written to disk automatically about a third of a second after you stop typing.
- **Deleting**: notes and folders go to the system trash, so they can be recovered.
- **Outside changes**: the vault is watched. Files added, edited or removed by another program (an editor, git, a sync client) are picked up live.

### How links resolve

- `[[Garden plan]]` matches a note by name, ignoring case, wherever it is in the vault. If several notes share the name, the one with the shortest path wins.
- `[[Projects/Garden plan]]` matches by path, either from the vault root or as the tail end of a longer path.
- `[[Note#Heading]]` and `[[Note|label]]` resolve to `Note`; the heading is not yet used for scrolling.
- Links inside code spans and fenced code blocks are ignored.
- When a note or folder is renamed or moved, every link that pointed at an affected note is rewritten so it still resolves.

### Tags and frontmatter

- `#tag` anywhere in the text of a note is a tag. Nested tags such as `#project/garden` are treated as one tag.
- A YAML frontmatter block (between `---` lines at the top of a note) is hidden in Read mode. Its contents are not parsed, so tags listed there are not picked up.

### Compatibility with Obsidian

Because a vault is only Markdown files and wikilinks, an Obsidian vault can be opened as is, and the reverse. What does not carry over: embeds (`![[...]]` shows as a plain link), canvases, plugins, and anything stored in `.obsidian`.

## How it is put together

Noidisbo is an Electron app in three parts.

```
src/
  main/index.ts          Main process: all disk access
  preload/index.ts       The narrow bridge exposed to the interface as window.api
  renderer/
    index.html
    src/
      App.tsx            Application shell and all note/folder operations
      lib/vault.ts       Link parsing, the vault index, link rewriting
      components/
        Editor.tsx       CodeMirror 6 editor: autosave, link autocomplete
        livePreview.ts   Live mode: hides Markdown syntax away from the cursor
        Reader.tsx       Read mode, rendered with markdown-it
        FileTree.tsx     Sidebar tree, folder actions, drag and drop
        Graph.tsx        Force-directed graph drawn on a canvas
        Switcher.tsx     Quick switcher
      styles.css         All styling, including the three themes
sample-vault/            A few example notes
build/icon.png           App icon used by `npm run dist`
```

- **Main process** (`src/main`): the only code that touches the filesystem. It scans the vault, reads and writes notes, moves and trashes files, and watches the folder with chokidar. Every path from the interface is checked to be inside the vault before use.
- **Preload** (`src/preload`): exposes a small set of functions (`loadVault`, `writeNote`, `movePath`, `trashPath` and so on) to the interface. The interface has no direct Node or filesystem access.
- **Renderer** (`src/renderer`): a React app. On opening a vault it receives every note's text and keeps it in memory. From that it builds an index of links, backlinks, tags and headings (`lib/vault.ts`), re-parsing only notes whose text changed.

How changes flow:

1. You type; the editor waits briefly, then hands the new text to `App.tsx`.
2. `App.tsx` updates its in-memory copy and asks the main process to write the file.
3. The main process remembers what it wrote, so when the file watcher reports that change it is ignored as the app's own.
4. A change from outside the app does not match, so it is sent to the interface, which updates the note and the index.

Raw HTML inside notes is not rendered, and external links open in the system browser, not inside the app.

## Known limitations

- No plugins, sync, canvas, embeds or image previews in the editor.
- Tables and fenced code blocks are not fully rendered in Live mode; use Read mode for those.
- The whole vault is held in memory, which is fine for thousands of notes but untested for very large vaults.
- Only tested on macOS on Apple silicon.
