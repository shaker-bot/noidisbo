import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot, VaultEvent } from './env'
import { Editor, type EditorHandle } from './components/Editor'
import { Reader } from './components/Reader'
import { FileTree } from './components/FileTree'
import { Graph } from './components/Graph'
import { Switcher } from './components/Switcher'
import {
  baseName,
  buildIndex,
  dirName,
  joinPath,
  linkTarget,
  linkingLines,
  rewriteLinks,
  sanitizeName
} from './lib/vault'

type Notes = Map<string, string>
type SideTab = 'files' | 'search' | 'tags'
type Mode = 'live' | 'source' | 'read'

const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'solarized', label: 'Solarized' },
  { id: 'dracula', label: 'Dracula' }
] as const
type Theme = (typeof THEMES)[number]['id']

function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    return THEMES.find((t) => t.id === saved)?.id ?? 'dark'
  } catch {
    return 'dark'
  }
}

const today = (): string => {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function App() {
  const [root, setRoot] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState<Notes>(new Map())
  const [dirs, setDirs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('live')
  const [view, setView] = useState<'note' | 'graph'>('note')
  const [sideTab, setSideTab] = useState<SideTab>('files')
  const [query, setQuery] = useState('')
  const [switcher, setSwitcher] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [renamingDir, setRenamingDir] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* the choice just won't be remembered */
    }
  }, [theme])

  const notesRef = useRef(notes)
  const activeRef = useRef(active)
  activeRef.current = active
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const editor = useRef<EditorHandle>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  /** Update notes synchronously in the ref as well, so handlers never act on stale state. */
  const update = useCallback((fn: (prev: Notes) => Notes) => {
    const next = fn(notesRef.current)
    notesRef.current = next
    setNotes(next)
  }, [])

  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])

  const applySnapshot = useCallback((snap: Snapshot | null) => {
    setLoading(false)
    if (!snap) return
    const map: Notes = new Map(snap.notes.map((n) => [n.path, n.content]))
    notesRef.current = map
    setNotes(map)
    setDirs(snap.dirs)
    setRoot(snap.root)
    setView('note')
    const first =
      [...map.keys()].find((p) => baseName(p).toLowerCase() === 'welcome') ?? [...map.keys()].sort()[0] ?? null
    setActive(first)
  }, [])

  useEffect(() => {
    window.api.loadVault().then(applySnapshot, fail)
  }, [applySnapshot, fail])

  useEffect(
    () =>
      window.api.onVaultEvent((e: VaultEvent) => {
        if (e.type === 'upsert') {
          if (notesRef.current.get(e.path) !== e.content) update((m) => new Map(m).set(e.path, e.content))
        } else if (e.type === 'remove') {
          if (!notesRef.current.has(e.path)) return
          update((m) => {
            const next = new Map(m)
            next.delete(e.path)
            return next
          })
          if (activeRef.current === e.path) setActive(null)
        } else if (e.type === 'addDir') {
          setDirs((d) => (d.includes(e.path) ? d : [...d, e.path]))
        } else {
          setDirs((d) => d.filter((p) => p !== e.path && !p.startsWith(e.path + '/')))
        }
      }),
    [update]
  )

  const index = useMemo(() => buildIndex(notes), [notes])
  const paths = useMemo(() => [...notes.keys()].sort((a, b) => a.localeCompare(b)), [notes])

  const openNote = useCallback((path: string) => {
    editor.current?.flush()
    setActive(path)
    setView('note')
  }, [])

  const exists = (path: string): boolean => {
    const lower = path.toLowerCase()
    for (const p of notesRef.current.keys()) if (p.toLowerCase() === lower) return true
    return false
  }

  const createNote = useCallback(
    async (name: string, dir = '', content = '', unique = false): Promise<void> => {
      const clean = name.split('/').map(sanitizeName).filter(Boolean).join('/') || 'Untitled'
      let path = joinPath(dir, clean + '.md')
      if (exists(path)) {
        if (!unique) return openNote([...notesRef.current.keys()].find((p) => p.toLowerCase() === path.toLowerCase())!)
        for (let i = 1; exists(path); i++) path = joinPath(dir, `${clean} ${i}.md`)
      }
      try {
        await window.api.writeNote(path, content)
        update((m) => new Map(m).set(path, content))
        const parent = dirName(path)
        if (parent) setDirs((d) => (d.includes(parent) ? d : [...d, parent]))
        openNote(path)
        setMode((m) => (m === 'read' ? 'live' : m))
      } catch (e) {
        fail(e)
      }
    },
    [fail, openNote, update]
  )

  const openLink = useCallback(
    (raw: string) => {
      const target = linkTarget(raw) // drop any #heading or |alias
      const from = activeRef.current ?? undefined
      const dest = buildIndex(notesRef.current).resolve(target, from)
      if (dest) openNote(dest)
      else void createNote(target.replace(/\.md$/i, ''), '', `# ${baseName(target)}\n\n`)
    },
    [createNote, openNote]
  )

  const saveNote = useCallback(
    (path: string, content: string) => {
      if (!notesRef.current.has(path)) return // renamed or deleted while an edit was pending
      update((m) => new Map(m).set(path, content))
      window.api.writeNote(path, content).catch(fail)
    },
    [fail, update]
  )

  const existsAny = (path: string): boolean =>
    exists(path) || dirsRef.current.some((d) => d.toLowerCase() === path.toLowerCase())

  /**
   * Move notes on disk and in memory. `moves` maps every affected note's old path to its new one;
   * links that pointed at a moved note are rewritten so they keep working.
   */
  const relocate = useCallback(
    async (moves: Map<string, string>, fsFrom: string, fsTo: string, mapDir?: (dir: string) => string): Promise<void> => {
      editor.current?.flush()
      const before = notesRef.current
      const idx = buildIndex(before)
      const wasActive = activeRef.current
      const next: Notes = new Map()
      const writes: [string, string][] = []
      for (const [p, content] of before) {
        const rewritten = rewriteLinks(content, (target) => {
          const dest = idx.resolve(target, p)
          const moved = dest ? moves.get(dest) : undefined
          if (!dest || !moved) return null
          if (target.includes('/')) return moved.replace(/\.md$/i, '')
          return baseName(moved) !== baseName(dest) ? baseName(moved) : null
        })
        const path = moves.get(p) ?? p
        next.set(path, rewritten)
        if (rewritten !== content) writes.push([path, rewritten])
      }
      try {
        await window.api.movePath(fsFrom, fsTo)
        notesRef.current = next
        setNotes(next)
        if (mapDir) setDirs((d) => [...new Set(d.map(mapDir))])
        if (wasActive && moves.has(wasActive)) setActive(moves.get(wasActive)!)
        await Promise.all(writes.map(([p, c]) => window.api.writeNote(p, c)))
      } catch (e) {
        fail(e)
      }
    },
    [fail]
  )

  const renameNote = useCallback(
    async (path: string, rawName: string): Promise<void> => {
      const name = sanitizeName(rawName.replace(/\//g, ' '))
      if (!name || name === baseName(path)) return
      const to = joinPath(dirName(path), name + '.md')
      if (to.toLowerCase() !== path.toLowerCase() && existsAny(to)) {
        setError(`A note named “${name}” already exists in this folder.`)
        return
      }
      await relocate(new Map([[path, to]]), path, to)
    },
    [relocate]
  )

  const moveDir = useCallback(
    async (from: string, to: string): Promise<void> => {
      const moves = new Map<string, string>()
      for (const p of notesRef.current.keys()) if (p.startsWith(from + '/')) moves.set(p, to + p.slice(from.length))
      const mapDir = (d: string): string => (d === from || d.startsWith(from + '/') ? to + d.slice(from.length) : d)
      await relocate(moves, from, to, mapDir)
    },
    [relocate]
  )

  const renameDir = useCallback(
    async (path: string, rawName: string): Promise<void> => {
      const name = sanitizeName(rawName.replace(/\//g, ' '))
      if (!name || name === path.slice(path.lastIndexOf('/') + 1)) return
      const to = joinPath(dirName(path), name)
      if (to.toLowerCase() !== path.toLowerCase() && existsAny(to)) {
        setError(`“${name}” already exists there.`)
        return
      }
      await moveDir(path, to)
    },
    [moveDir]
  )

  /** Drag and drop: move a note or a folder into `destDir` ('' is the vault root). */
  const moveEntry = useCallback(
    async (path: string, destDir: string): Promise<void> => {
      const isNote = notesRef.current.has(path)
      const to = joinPath(destDir, path.slice(path.lastIndexOf('/') + 1))
      if (to === path) return
      if (!isNote && (destDir === path || destDir.startsWith(path + '/'))) return // a folder can't go inside itself
      if (existsAny(to)) {
        setError(`“${to}” already exists.`)
        return
      }
      if (isNote) await relocate(new Map([[path, to]]), path, to)
      else await moveDir(path, to)
    },
    [moveDir, relocate]
  )

  const newFolder = useCallback(
    async (parent: string): Promise<string | null> => {
      let path = joinPath(parent, 'New folder')
      for (let i = 1; existsAny(path); i++) path = joinPath(parent, `New folder ${i}`)
      try {
        await window.api.createDir(path)
        setDirs((d) => (d.includes(path) ? d : [...d, path]))
        return path
      } catch (e) {
        fail(e)
        return null
      }
    },
    [fail]
  )

  const deleteDir = useCallback(
    async (path: string): Promise<void> => {
      const inside = [...notesRef.current.keys()].filter((p) => p.startsWith(path + '/'))
      const what = inside.length === 0 ? 'the empty folder' : `the folder and its ${inside.length} note${inside.length === 1 ? '' : 's'}`
      if (!window.confirm(`Move ${what} “${path}” to the trash?`)) return
      editor.current?.flush()
      try {
        await window.api.trashPath(path)
        update((m) => {
          const next = new Map(m)
          for (const p of inside) next.delete(p)
          return next
        })
        setDirs((d) => d.filter((p) => p !== path && !p.startsWith(path + '/')))
        if (activeRef.current && inside.includes(activeRef.current)) setActive(null)
      } catch (e) {
        fail(e)
      }
    },
    [fail, update]
  )

  const deleteNote = useCallback(
    async (path: string): Promise<void> => {
      if (!window.confirm(`Move “${baseName(path)}” to the trash?`)) return
      editor.current?.flush()
      try {
        await window.api.trashPath(path)
        update((m) => {
          const next = new Map(m)
          next.delete(path)
          return next
        })
        if (activeRef.current === path) setActive(null)
      } catch (e) {
        fail(e)
      }
    },
    [fail, update]
  )

  const pickVault = useCallback(() => {
    editor.current?.flush()
    window.api.pickVault().then(applySnapshot, fail)
  }, [applySnapshot, fail])

  const showTag = useCallback((tag: string) => {
    setQuery('#' + tag)
    setSideTab('search')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !root) return
      const key = e.key.toLowerCase()
      if (key === 'o' || key === 'p') setSwitcher(true)
      else if (key === 'n') void createNote('Untitled', dirName(activeRef.current ?? ''), '', true)
      else if (key === 'e') setMode((m) => (m === 'read' ? 'live' : 'read'))
      else if (key === 'g') {
        editor.current?.flush()
        setView((v) => (v === 'graph' ? 'note' : 'graph'))
      } else if (key === 'f' && e.shiftKey) {
        setSideTab('search')
        window.setTimeout(() => searchInput.current?.focus(), 0)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createNote, root])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const out: { path: string; snippet: string }[] = []
    for (const path of paths) {
      const content = notes.get(path)!
      const at = content.toLowerCase().indexOf(q)
      const inName = baseName(path).toLowerCase().includes(q)
      if (at < 0 && !inName) continue
      const start = Math.max(0, at - 30)
      const snippet = at < 0 ? '' : (start > 0 ? '…' : '') + content.slice(start, at + q.length + 60).replace(/\s+/g, ' ')
      out.push({ path, snippet })
      if (out.length >= 100) break
    }
    return out
  }, [notes, paths, query])

  const content = active !== null ? notes.get(active) : undefined
  const meta = active !== null ? index.metas.get(active) : undefined
  const resolveFromActive = useCallback((t: string) => index.resolve(t, active ?? undefined), [index, active])

  const backlinks = useMemo(() => {
    if (active === null) return []
    return [...(index.backlinks.get(active) ?? [])].sort().map((path) => ({
      path,
      lines: linkingLines(notes.get(path) ?? '', (t) => index.resolve(t, path) === active)
    }))
  }, [active, index, notes])

  const jumpToHeading = (line: number, nth: number): void => {
    if (mode !== 'read') editor.current?.scrollToLine(line)
    else document.querySelectorAll('.reader h1, .reader h2, .reader h3, .reader h4, .reader h5, .reader h6')[nth]?.scrollIntoView({ block: 'start' })
  }

  if (!root) {
    return (
      <div className="welcome">
        <div className="titlebar" />
        {!loading && (
          <div className="welcome-card">
            <h1>Noidisbo</h1>
            <p>
              Notes as plain Markdown files in a folder you own. Link them with <code>[[double brackets]]</code> and
              watch the connections build up.
            </p>
            <button className="primary" onClick={pickVault}>
              Open a folder
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        )}
      </div>
    )
  }

  const tagList = [...index.tags.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  return (
    <div className="app">
      <header className="titlebar">
        <span className="vault-name" title={root}>
          {root.split(/[\\/]/).pop()}
        </span>
        <div className="titlebar-actions">
          <button onClick={() => setSwitcher(true)} title="Find or create a note (Cmd+O)">
            Find
          </button>
          <button onClick={() => void createNote(today())} title="Open today's note">
            Today
          </button>
          <button
            className={view === 'graph' ? 'on' : ''}
            aria-pressed={view === 'graph'}
            onClick={() => {
              editor.current?.flush()
              setView(view === 'graph' ? 'note' : 'graph')
            }}
            title="Graph view (Cmd+G)"
          >
            Graph
          </button>
          <button
            onClick={() => setTheme(THEMES[(THEMES.findIndex((t) => t.id === theme) + 1) % THEMES.length].id)}
            title="Switch theme"
          >
            Theme: {THEMES.find((t) => t.id === theme)?.label}
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="tabs">
          {(['files', 'search', 'tags'] as const).map((tab) => (
            <button key={tab} className={sideTab === tab ? 'on' : ''} onClick={() => setSideTab(tab)}>
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <button
            className="tab-action"
            title="New folder"
            aria-label="New folder"
            onClick={() => {
              setSideTab('files')
              void newFolder('').then(setRenamingDir)
            }}
          >
            ▢
          </button>
          <button
            className="tab-action"
            title="New note (Cmd+N)"
            aria-label="New note"
            onClick={() => void createNote('Untitled', dirName(active ?? ''), '', true)}
          >
            +
          </button>
        </nav>
        <div className="sidebar-body">
          {sideTab === 'files' && (
            <FileTree
              paths={paths}
              dirs={dirs}
              active={active}
              onOpen={openNote}
              onDelete={(p) => void deleteNote(p)}
              onNewNote={(dir) => void createNote('Untitled', dir, '', true)}
              onNewFolder={newFolder}
              renaming={renamingDir}
              onRenaming={setRenamingDir}
              onRenameDir={(p, name) => void renameDir(p, name)}
              onDeleteDir={(p) => void deleteDir(p)}
              onMove={(p, dir) => void moveEntry(p, dir)}
            />
          )}
          {sideTab === 'search' && (
            <>
              <input
                ref={searchInput}
                className="search-input"
                value={query}
                placeholder="Search all notes…"
                aria-label="Search all notes"
                onChange={(e) => setQuery(e.target.value)}
              />
              {results.map((r) => (
                <div key={r.path} className={'result' + (r.path === active ? ' active' : '')} onClick={() => openNote(r.path)}>
                  <div className="result-name">{baseName(r.path)}</div>
                  {r.snippet && <div className="result-snippet">{r.snippet}</div>}
                </div>
              ))}
              {query.trim().length >= 2 && results.length === 0 && <p className="empty">Nothing matches.</p>}
            </>
          )}
          {sideTab === 'tags' &&
            (tagList.length === 0 ? (
              <p className="empty">No tags yet. Write #something in a note.</p>
            ) : (
              tagList.map(([tag, list]) => (
                <div key={tag} className="row" style={{ paddingLeft: 10 }} onClick={() => showTag(tag)}>
                  <span className="row-label">#{tag}</span>
                  <span className="count">{list.length}</span>
                </div>
              ))
            ))}
        </div>
        <button className="vault-switch" onClick={pickVault}>
          Open another folder…
        </button>
      </aside>

      <main className="main">
        {view === 'graph' ? (
          <Graph index={index} active={active} onOpen={openNote} />
        ) : active !== null && content !== undefined ? (
          <div className="note">
            <div className="note-head">
              <input
                key={active}
                className="note-title"
                defaultValue={baseName(active)}
                aria-label="Note name"
                spellCheck={false}
                onBlur={(e) => {
                  const path = active
                  void renameNote(path, e.target.value).then(() => {
                    if (!notesRef.current.has(path)) return
                    e.target.value = baseName(path) // rename was refused: restore the real name
                  })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.currentTarget.value = baseName(active)
                    e.currentTarget.blur()
                  }
                }}
              />
              <div className="segmented" role="group" aria-label="View mode">
                <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')} title="Markdown rendered as you type">
                  Live
                </button>
                <button className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')} title="Raw Markdown">
                  Source
                </button>
                <button
                  className={mode === 'read' ? 'on' : ''}
                  onClick={() => {
                    editor.current?.flush()
                    setMode('read')
                  }}
                >
                  Read
                </button>
              </div>
            </div>
            <div className="note-body">
              {mode !== 'read' ? (
                <Editor
                  key={active}
                  ref={editor}
                  content={content}
                  names={index.names}
                  live={mode === 'live'}
                  onChange={(doc) => saveNote(active, doc)}
                  onOpenLink={openLink}
                />
              ) : (
                <Reader content={content} resolve={resolveFromActive} onOpenLink={openLink} onTag={showTag} />
              )}
            </div>
          </div>
        ) : (
          <div className="blank">
            <p>No note open.</p>
            <p className="dim">Cmd+O to find a note · Cmd+N to write a new one</p>
          </div>
        )}
      </main>

      <aside className="panel">
        {view === 'note' && active !== null && meta && (
          <>
            <h2>Backlinks</h2>
            {backlinks.length === 0 && <p className="empty">Nothing links here yet.</p>}
            {backlinks.map((b) => (
              <div key={b.path} className="backlink" onClick={() => openNote(b.path)}>
                <div className="result-name">{baseName(b.path)}</div>
                {b.lines.slice(0, 3).map((line, i) => (
                  <div key={i} className="result-snippet">
                    {line}
                  </div>
                ))}
              </div>
            ))}
            <h2>Outline</h2>
            {meta.headings.length === 0 && <p className="empty">No headings.</p>}
            {meta.headings.map((h, i) => (
              <div
                key={h.line}
                className="row outline"
                style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
                onClick={() => jumpToHeading(h.line, i)}
              >
                <span className="row-label">{h.text}</span>
              </div>
            ))}
          </>
        )}
        {view === 'graph' && (
          <>
            <h2>Graph</h2>
            <p className="empty">
              {index.metas.size} notes. Drag to move, scroll to zoom, click a dot to open its note.
            </p>
          </>
        )}
      </aside>

      {switcher && (
        <Switcher paths={paths} onOpen={openNote} onCreate={(name) => void createNote(name)} onClose={() => setSwitcher(false)} />
      )}
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}
