import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  drawSelection,
  keymap,
  placeholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import { livePreview } from './livePreview'

export interface EditorHandle {
  /** Emit any pending edit immediately. */
  flush(): void
  scrollToLine(line: number): void
}

interface Props {
  content: string
  names: string[]
  /** Render Markdown in place instead of showing raw syntax. */
  live: boolean
  onChange(content: string): void
  onOpenLink(target: string): void
}

const SAVE_DELAY = 300

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-h tok-h1' },
  { tag: t.heading2, class: 'tok-h tok-h2' },
  { tag: t.heading3, class: 'tok-h tok-h3' },
  { tag: [t.heading4, t.heading5, t.heading6], class: 'tok-h' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.monospace, class: 'tok-code' },
  { tag: [t.link, t.url], class: 'tok-url' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], class: 'tok-mark' }
])

function matchPlugin(decorator: MatchDecorator) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = decorator.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations }
  )
}

const wikilinks = matchPlugin(
  new MatchDecorator({
    regexp: /\[\[([^[\]\n]+?)\]\]/g,
    decoration: (m) =>
      Decoration.mark({
        class: 'cm-wikilink',
        attributes: { 'data-target': m[1], title: 'Cmd-click to open' }
      })
  })
)

const hashtags = matchPlugin(
  new MatchDecorator({
    regexp: /(?<=^|\s)#[A-Za-z][\w/-]*/g,
    decoration: () => Decoration.mark({ class: 'cm-hashtag' })
  })
)

/** Wrap the selection in `mark`, or unwrap it if it is already wrapped. */
function toggleWrap(mark: string) {
  return (view: EditorView): boolean => {
    const { state } = view
    const tr = state.changeByRange((range) => {
      const n = mark.length
      const before = state.sliceDoc(range.from - n, range.from)
      const after = state.sliceDoc(range.to, range.to + n)
      if (before === mark && after === mark) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n }
          ],
          range: EditorSelection.range(range.from - n, range.to - n)
        }
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark }
        ],
        range: EditorSelection.range(range.from + n, range.to + n)
      }
    })
    view.dispatch(tr)
    return true
  }
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { content, names, live, onChange, onOpenLink },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const timer = useRef<number | null>(null)
  const lastEmitted = useRef(content)
  const namesRef = useRef(names)
  const liveRef = useRef(live)
  liveRef.current = live
  const liveMode = useRef(new Compartment()).current
  const onChangeRef = useRef(onChange)
  const onOpenLinkRef = useRef(onOpenLink)
  namesRef.current = names
  onChangeRef.current = onChange
  onOpenLinkRef.current = onOpenLink

  const flush = (): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    lastEmitted.current = doc
    onChangeRef.current(doc)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  useImperativeHandle(ref, () => ({
    flush: () => flushRef.current(),
    scrollToLine(line: number) {
      const view = viewRef.current
      if (!view) return
      const pos = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines)).from
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) })
      view.focus()
    }
  }))

  useEffect(() => {
    const complete = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\[\[[^[\]|#\n]*/)
      if (!m) return null
      return {
        from: m.from + 2,
        validFor: /^[^[\]|#\n]*$/,
        options: namesRef.current.map((name) => ({
          label: name,
          type: 'text',
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            const closed = view.state.sliceDoc(to, to + 2) === ']]'
            view.dispatch({
              changes: { from, to, insert: closed ? name : name + ']]' },
              selection: { anchor: from + name.length + 2 }
            })
          }
        }))
      }
    }

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: content,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          closeBrackets(),
          search({ top: true }),
          autocompletion({ override: [complete], icons: false }),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          wikilinks,
          hashtags,
          liveMode.of(live ? livePreview : []),
          EditorView.lineWrapping,
          placeholder('Start writing…  Type [[ to link another note.'),
          keymap.of([
            { key: 'Mod-b', run: toggleWrap('**') },
            { key: 'Mod-i', run: toggleWrap('*') },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab
          ]),
          EditorView.domEventHandlers({
            mousedown(event) {
              const el = event.target as HTMLElement
              const mod = event.metaKey || event.ctrlKey
              if (!mod && !liveRef.current) return false
              const link = el.closest<HTMLElement>('.cm-wikilink')
              // In live preview a plain click follows a link, unless its raw text is being edited.
              if (link?.dataset.target && (mod || !link.textContent?.startsWith('[['))) {
                event.preventDefault()
                onOpenLinkRef.current(link.dataset.target)
                return true
              }
              const href = el.closest<HTMLElement>('.cm-live-link')?.dataset.href
              if (href && /^https?:\/\//i.test(href)) {
                event.preventDefault()
                void window.api.openExternal(href)
                return true
              }
              return false
            }
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (timer.current !== null) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => flushRef.current(), SAVE_DELAY)
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      flushRef.current()
      view.destroy()
      viewRef.current = null
    }
    // The editor is keyed by note path, so it is created once per note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: liveMode.reconfigure(live ? livePreview : []) })
  }, [live, liveMode])

  // Take in changes made outside the editor (another app edited the file, links rewritten on rename).
  useEffect(() => {
    const view = viewRef.current
    if (!view || content === lastEmitted.current) return
    lastEmitted.current = content
    if (content === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
  }, [content])

  return <div className="editor" ref={host} />
})
