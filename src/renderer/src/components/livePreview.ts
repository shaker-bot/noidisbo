import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

/**
 * Live preview: Markdown syntax is hidden and rendered in place, except around the cursor,
 * where the raw text is shown so it can be edited.
 */

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-live-bullet'
    el.textContent = '•'
    return el
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-live-hr'
    return el
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-live-task'
    box.setAttribute('aria-label', 'Task done')
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(box)
      const text = view.state.sliceDoc(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(text)) return
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === ' ' ? 'x' : ' ' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return true
  }
}

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const rule = Decoration.replace({ widget: new RuleWidget() })
const quoteLine = Decoration.line({ class: 'cm-live-quote' })
const codeLine = Decoration.line({ class: 'cm-live-code' })
const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g

function build(view: EditorView): DecorationSet {
  const { state } = view
  const out: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  const selection = state.selection.ranges
  const touches = (from: number, to: number): boolean => selection.some((r) => r.from <= to && r.to >= from)
  const linesTouched = (from: number, to: number): boolean =>
    touches(state.doc.lineAt(from).from, state.doc.lineAt(to).to)
  const hide = (from: number, to: number): void => {
    if (to > from) out.push(hidden.range(from, to))
  }
  const eachLine = (from: number, to: number, deco: Decoration): void => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      out.push(deco.range(line.from))
      pos = line.to + 1
    }
  }
  const inCode = (pos: number): boolean => {
    for (let n: { name: string; parent: unknown } | null = tree.resolveInner(pos, 1); n; n = n.parent as typeof n) {
      if (n.name.includes('Code')) return true
    }
    return false
  }
  const seenBlocks = new Set<number>()

  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const { name, from, to } = node
        const parent = node.node.parent
        if (name === 'HeaderMark') {
          if (!parent?.name.startsWith('ATXHeading') || linesTouched(parent.from, parent.to)) return
          const space = from === parent.from && state.sliceDoc(to, to + 1) === ' ' ? 1 : 0
          hide(from, to + space)
        } else if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          if (parent && !touches(parent.from, parent.to)) hide(from, to)
        } else if (name === 'CodeMark') {
          if (parent?.name === 'InlineCode' && !touches(parent.from, parent.to)) hide(from, to)
        } else if (name === 'Link') {
          const url = node.node.getChild('URL')
          const marks = node.node.getChildren('LinkMark')
          if (!url || marks.length < 2 || touches(from, to)) return
          hide(marks[0].from, marks[0].to)
          hide(marks[1].from, to)
          if (marks[1].from > marks[0].to) {
            out.push(
              Decoration.mark({
                class: 'cm-live-link',
                attributes: { 'data-href': state.sliceDoc(url.from, url.to) }
              }).range(marks[0].to, marks[1].from)
            )
          }
        } else if (name === 'ListMark') {
          if (parent?.parent?.name !== 'BulletList') return
          if (node.node.nextSibling?.name === 'Task') {
            if (!linesTouched(from, from)) hide(from, Math.min(to + 1, state.doc.lineAt(from).to))
          } else if (!touches(from, to)) {
            out.push(bullet.range(from, to))
          }
        } else if (name === 'TaskMarker') {
          if (!touches(from, to)) {
            const checked = /[xX]/.test(state.sliceDoc(from, to))
            out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(from, to))
          }
        } else if (name === 'HorizontalRule') {
          if (!linesTouched(from, to)) out.push(rule.range(from, to))
        } else if (name === 'QuoteMark') {
          if (linesTouched(from, from)) return
          const space = state.sliceDoc(to, to + 1) === ' ' ? 1 : 0
          hide(from, to + space)
        } else if (name === 'Blockquote' || name === 'FencedCode') {
          if (seenBlocks.has(from)) return
          seenBlocks.add(from)
          eachLine(from, to, name === 'Blockquote' ? quoteLine : codeLine)
        }
      }
    })

    const text = state.sliceDoc(visible.from, visible.to)
    for (const m of text.matchAll(WIKILINK)) {
      const start = visible.from + m.index
      const end = start + m[0].length
      if (touches(start, end) || inCode(start)) continue
      const bar = m[1].indexOf('|')
      const hasAlias = bar >= 0 && m[1].slice(bar + 1).trim() !== ''
      hide(start, hasAlias ? start + 2 + bar + 1 : start + 2)
      hide(end - 2, end)
    }
  }
  return Decoration.set(out, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = build(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)
