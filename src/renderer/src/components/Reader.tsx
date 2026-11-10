import { useMemo, type MouseEvent } from 'react'
import MarkdownIt from 'markdown-it'
import { linkLabel, linkTarget } from '../lib/vault'

interface Env {
  resolve(target: string): string | null
}

// Raw HTML in notes is not rendered: notes can come from anywhere.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const { src, pos } = state
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false
  const end = src.indexOf(']]', pos + 2)
  if (end < 0) return false
  const inner = src.slice(pos + 2, end)
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false
  if (!silent) state.push('wikilink', '', 0).content = inner
  state.pos = end + 2
  return true
})

md.renderer.rules.wikilink = (tokens, idx, _options, env: Env) => {
  const inner = tokens[idx].content
  const target = linkTarget(inner)
  const missing = target !== '' && env.resolve(target) === null
  const esc = md.utils.escapeHtml
  return `<a class="wikilink${missing ? ' missing' : ''}" data-wikilink="${esc(target)}">${esc(linkLabel(inner))}</a>`
}

md.renderer.rules.text = (tokens, idx) =>
  md.utils
    .escapeHtml(tokens[idx].content)
    .replace(/(^|\s)#([A-Za-z][\w/-]*)/g, '$1<a class="tag" data-tag="$2">#$2</a>')

interface Props {
  content: string
  resolve(target: string): string | null
  onOpenLink(target: string): void
  onTag(tag: string): void
}

export function Reader({ content, resolve, onOpenLink, onTag }: Props) {
  const html = useMemo(() => {
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '') // hide frontmatter
    return md.render(body, { resolve } satisfies Env)
  }, [content, resolve])

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    if (a.dataset.wikilink !== undefined) onOpenLink(a.dataset.wikilink)
    else if (a.dataset.tag) onTag(a.dataset.tag)
    else {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) void window.api.openExternal(href)
    }
  }

  return <div className="reader" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
