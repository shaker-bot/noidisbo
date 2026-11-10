export interface Heading {
  level: number
  text: string
  line: number // 1-based
}

export interface NoteMeta {
  path: string
  name: string
  /** Raw link targets as written, without alias or heading. */
  links: string[]
  tags: string[]
  headings: Heading[]
}

export interface VaultIndex {
  metas: Map<string, NoteMeta>
  resolve(target: string, from?: string): string | null
  outgoing: Map<string, Set<string>>
  backlinks: Map<string, Set<string>>
  tags: Map<string, string[]>
  names: string[]
}

export const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g
const TAG = /(?:^|\s)#([A-Za-z][\w/-]*)/g

export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '')
export const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

/** `Note#Heading|Alias` -> `Note` */
export const linkTarget = (inner: string): string => inner.split('|')[0].split('#')[0].trim()

/** `Note#Heading|Alias` -> `Alias`, or the target text when there is no alias. */
export function linkLabel(inner: string): string {
  const bar = inner.indexOf('|')
  return (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
}

/** Strip characters that can't appear in a file name or would break link syntax. */
export const sanitizeName = (name: string): string =>
  name.replace(/[\\:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim()

export function parseNote(path: string, content: string): NoteMeta {
  const links: string[] = []
  const tags = new Set<string>()
  const headings: Heading[] = []
  const lines = content.split('\n')
  let inFence = false
  let inFrontmatter = lines[0]?.trim() === '---'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inFrontmatter) {
      if (i > 0 && line.trim() === '---') inFrontmatter = false
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 })

    const text = line.replace(/`[^`]*`/g, '')
    for (const m of text.matchAll(WIKILINK)) {
      const target = linkTarget(m[1])
      if (target) links.push(target)
    }
    for (const m of text.replace(WIKILINK, ' ').matchAll(TAG)) tags.add(m[1])
  }
  return { path, name: baseName(path), links, tags: [...tags], headings }
}

const metaCache = new Map<string, { content: string; meta: NoteMeta }>()

export function buildIndex(notes: Map<string, string>): VaultIndex {
  const metas = new Map<string, NoteMeta>()
  for (const [path, content] of notes) {
    const hit = metaCache.get(path)
    if (hit && hit.content === content) {
      metas.set(path, hit.meta)
    } else {
      const meta = parseNote(path, content)
      metaCache.set(path, { content, meta })
      metas.set(path, meta)
    }
  }
  for (const path of metaCache.keys()) if (!notes.has(path)) metaCache.delete(path)

  const byName = new Map<string, string[]>()
  const byPath = new Map<string, string>()
  for (const path of notes.keys()) {
    const key = baseName(path).toLowerCase()
    const list = byName.get(key)
    if (list) list.push(path)
    else byName.set(key, [path])
    byPath.set(path.replace(/\.md$/i, '').toLowerCase(), path)
  }
  const best = (paths: string[] | undefined): string | null =>
    paths?.length ? [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] : null

  const resolve = (target: string, from?: string): string | null => {
    const t = target.replace(/\.md$/i, '').trim().toLowerCase()
    if (!t) return from ?? null
    if (!t.includes('/')) return best(byName.get(t))
    const exact = byPath.get(t)
    if (exact) return exact
    const matches: string[] = []
    for (const [key, path] of byPath) if (key.endsWith('/' + t)) matches.push(path)
    return best(matches)
  }

  const outgoing = new Map<string, Set<string>>()
  const backlinks = new Map<string, Set<string>>()
  const tags = new Map<string, string[]>()
  for (const meta of metas.values()) {
    const out = new Set<string>()
    for (const target of meta.links) {
      const dest = resolve(target, meta.path)
      if (!dest || dest === meta.path) continue
      out.add(dest)
      let back = backlinks.get(dest)
      if (!back) backlinks.set(dest, (back = new Set()))
      back.add(meta.path)
    }
    outgoing.set(meta.path, out)
    for (const tag of meta.tags) {
      const list = tags.get(tag)
      if (list) list.push(meta.path)
      else tags.set(tag, [meta.path])
    }
  }

  const names = [...new Set([...metas.values()].map((m) => m.name))].sort((a, b) => a.localeCompare(b))
  return { metas, resolve, outgoing, backlinks, tags, names }
}

/** Rewrite link targets: `retarget` returns the new target, or null to leave the link alone. */
export function rewriteLinks(content: string, retarget: (target: string) => string | null): string {
  return content.replace(WIKILINK, (whole, inner: string) => {
    const target = linkTarget(inner)
    if (!target) return whole
    const next = retarget(target)
    if (next === null || next === target) return whole
    const rest = inner.slice(inner.split('|')[0].split('#')[0].length)
    return `[[${next}${rest}]]`
  })
}

/** Lines of `content` that link to `dest`, for backlink context. */
export function linkingLines(content: string, resolvesToDest: (target: string) => boolean): string[] {
  const out: string[] = []
  for (const line of content.split('\n')) {
    for (const m of line.matchAll(WIKILINK)) {
      if (resolvesToDest(linkTarget(m[1]))) {
        out.push(line.trim())
        break
      }
    }
  }
  return out
}
