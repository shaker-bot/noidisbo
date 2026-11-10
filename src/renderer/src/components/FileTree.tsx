import { useMemo, useRef, useState, type DragEvent } from 'react'
import { baseName } from '../lib/vault'

interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'note'
  children: TreeNode[]
}

function buildTree(paths: string[], dirs: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] }
  const dirNodes = new Map<string, TreeNode>([['', root]])
  const ensureDir = (path: string): TreeNode => {
    const hit = dirNodes.get(path)
    if (hit) return hit
    const cut = path.lastIndexOf('/')
    const parent = ensureDir(cut < 0 ? '' : path.slice(0, cut))
    const node: TreeNode = { name: path.slice(cut + 1), path, kind: 'dir', children: [] }
    parent.children.push(node)
    dirNodes.set(path, node)
    return node
  }
  dirs.forEach(ensureDir)
  for (const path of paths) {
    const cut = path.lastIndexOf('/')
    ensureDir(cut < 0 ? '' : path.slice(0, cut)).children.push({
      name: baseName(path),
      path,
      kind: 'note',
      children: []
    })
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1
    )
    node.children.forEach(sort)
  }
  sort(root)
  return root.children
}

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

interface Props {
  paths: string[]
  dirs: string[]
  active: string | null
  onOpen(path: string): void
  onDelete(path: string): void
  onNewNote(dir: string): void
  /** Creates a folder and resolves to its path, so it can be named straight away. */
  onNewFolder(parent: string): Promise<string | null>
  /** The folder whose name is being edited in place, if any. */
  renaming: string | null
  onRenaming(path: string | null): void
  onRenameDir(path: string, name: string): void
  onDeleteDir(path: string): void
  /** Move a note or folder into `destDir` ('' is the vault root). */
  onMove(path: string, destDir: string): void
}

export function FileTree(props: Props) {
  const { paths, dirs, active, onOpen, onDelete, onNewNote, onNewFolder, onRenameDir, onDeleteDir, onMove, renaming } = props
  const setRenaming = props.onRenaming
  const tree = useMemo(() => buildTree(paths, dirs), [paths, dirs])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [dropDir, setDropDir] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)

  const toggle = (path: string): void =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const addFolder = async (parent: string): Promise<void> => {
    setClosed((prev) => {
      const next = new Set(prev)
      next.delete(parent)
      return next
    })
    const path = await onNewFolder(parent)
    if (path) setRenaming(path)
  }

  /** Drag-and-drop handlers for anything that drops into `dir`. */
  const dropInto = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      if (dragging.current === null) return
      e.preventDefault()
      e.stopPropagation()
      setDropDir(dir)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const path = dragging.current
      dragging.current = null
      setDropDir(null)
      if (path !== null) onMove(path, dir)
    }
  })
  const draggable = (path: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragging.current = path
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', path)
    },
    onDragEnd: () => {
      dragging.current = null
      setDropDir(null)
    }
  })

  const action = (label: string, glyph: string, run: () => void): JSX.Element => (
    <button
      className="row-action"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        run()
      }}
    >
      {glyph}
    </button>
  )

  const render = (nodes: TreeNode[], depth: number): JSX.Element[] =>
    nodes.flatMap((node) => {
      const pad = { paddingLeft: 10 + depth * 14 }
      if (node.kind === 'note') {
        return [
          <div
            key={node.path}
            className={'row leaf' + (node.path === active ? ' active' : '')}
            style={pad}
            onClick={() => onOpen(node.path)}
            title={node.path}
            {...draggable(node.path)}
            {...dropInto(parentOf(node.path))}
          >
            <span className="row-label">{node.name}</span>
            {action(`Move ${node.name} to trash`, '×', () => onDelete(node.path))}
          </div>
        ]
      }
      const open = !closed.has(node.path)
      return [
        <div
          key={node.path}
          className={'row dir' + (dropDir === node.path ? ' drop' : '')}
          style={pad}
          onClick={() => toggle(node.path)}
          title={node.path}
          {...(renaming === node.path ? {} : draggable(node.path))}
          {...dropInto(node.path)}
        >
          <span className={'chevron' + (open ? ' open' : '')}>›</span>
          {renaming === node.path ? (
            <input
              className="row-rename"
              autoFocus
              defaultValue={node.name}
              aria-label="Folder name"
              spellCheck={false}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setRenaming(null)
                onRenameDir(node.path, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.currentTarget.value = node.name
                  e.currentTarget.blur()
                }
              }}
            />
          ) : (
            <>
              <span className="row-label">{node.name}</span>
              {action(`New note in ${node.name}`, '+', () => onNewNote(node.path))}
              {action(`New folder in ${node.name}`, '▢', () => void addFolder(node.path))}
              {action(`Rename ${node.name}`, '✎', () => setRenaming(node.path))}
              {action(`Move ${node.name} to trash`, '×', () => onDeleteDir(node.path))}
            </>
          )}
        </div>,
        ...(open ? render(node.children, depth + 1) : [])
      ]
    })

  return (
    <div className={'tree' + (dropDir === '' ? ' drop-root' : '')} {...dropInto('')}>
      {tree.length === 0 ? <p className="empty">No notes yet. Press Cmd+N to write the first one.</p> : render(tree, 0)}
    </div>
  )
}
