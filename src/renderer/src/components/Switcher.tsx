import { useEffect, useMemo, useRef, useState } from 'react'
import { baseName, dirName, sanitizeName } from '../lib/vault'

/** Lower is better; -1 means no match. Substring hits beat scattered-letter hits. */
function score(name: string, query: string): number {
  const n = name.toLowerCase()
  const at = n.indexOf(query)
  if (at >= 0) return at
  let i = 0
  for (const ch of n) if (ch === query[i]) i++
  return i === query.length ? 1000 + n.length : -1
}

interface Props {
  paths: string[]
  onOpen(path: string): void
  onCreate(name: string): void
  onClose(): void
}

type Item = { kind: 'note'; path: string } | { kind: 'create'; name: string }

export function Switcher({ paths, onOpen, onCreate, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const ranked = paths
      .map((path) => ({ path, s: q ? score(baseName(path), q) : 0 }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || a.path.localeCompare(b.path))
      .slice(0, 50)
      .map<Item>((r) => ({ kind: 'note', path: r.path }))
    const name = sanitizeName(query)
    const exact = paths.some((p) => baseName(p).toLowerCase() === name.toLowerCase())
    return name && !exact ? [...ranked, { kind: 'create', name }] : ranked
  }, [paths, query])

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    list.current?.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (item: Item | undefined): void => {
    if (!item) return
    if (item.kind === 'note') onOpen(item.path)
    else onCreate(item.name)
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="Find or create a note…"
          aria-label="Find or create a note"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter') choose(items[cursor])
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
          }}
        />
        <div className="switcher-list" ref={list}>
          {items.map((item, i) => (
            <div
              key={item.kind === 'note' ? item.path : '+new'}
              className={'switcher-item' + (i === cursor ? ' active' : '')}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(item)}
            >
              {item.kind === 'note' ? (
                <>
                  <span>{baseName(item.path)}</span>
                  <span className="dim">{dirName(item.path)}</span>
                </>
              ) : (
                <>
                  <span>Create “{item.name}”</span>
                  <span className="dim">new note</span>
                </>
              )}
            </div>
          ))}
          {items.length === 0 && <div className="switcher-item dim">No notes</div>}
        </div>
      </div>
    </div>
  )
}
