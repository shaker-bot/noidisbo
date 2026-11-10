import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'

interface Snapshot {
  root: string
  notes: { path: string; content: string }[]
  dirs: string[]
}

let win: BrowserWindow | null = null
let vault: string | null = null
let watcher: FSWatcher | null = null
/** Content we last wrote ourselves, so the watcher can ignore our own saves. */
const lastWritten = new Map<string, string>()

const stateFile = () => path.join(app.getPath('userData'), 'state.json')

function loadState(): string | null {
  const fromEnv = process.env.NOIDISBO_VAULT
  if (fromEnv && existsSync(fromEnv)) return path.resolve(fromEnv)
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8')).vault
    return typeof saved === 'string' && existsSync(saved) ? saved : null
  } catch {
    return null
  }
}

function saveState(): void {
  try {
    writeFileSync(stateFile(), JSON.stringify({ vault }))
  } catch {
    /* not fatal: the vault just won't be remembered */
  }
}

const toRel = (abs: string) => path.relative(vault!, abs).split(path.sep).join('/')
const isHidden = (name: string) => name.startsWith('.') || name === 'node_modules'
const isNote = (name: string) => name.toLowerCase().endsWith('.md')

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
function inVault(rel: string): string {
  if (!vault) throw new Error('No vault is open')
  const abs = path.resolve(vault, rel)
  if (abs !== vault && !abs.startsWith(vault + path.sep)) throw new Error('Path is outside the vault')
  return abs
}

async function scan(): Promise<Snapshot> {
  const root = vault!
  const files: string[] = []
  const dirs: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (isHidden(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        dirs.push(toRel(abs))
        await walk(abs)
      } else if (e.isFile() && isNote(e.name)) {
        files.push(abs)
      }
    }
  }
  await walk(root)
  const notes = await Promise.all(
    files.map(async (abs) => ({ path: toRel(abs), content: await fs.readFile(abs, 'utf8') }))
  )
  return { root, notes, dirs }
}

function send(event: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send('vault:event', event)
}

async function setVault(dir: string): Promise<Snapshot> {
  await watcher?.close()
  vault = path.resolve(dir)
  lastWritten.clear()
  saveState()
  const root = vault
  watcher = watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => path.relative(root, p).split(path.sep).some(isHidden),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 }
  })
  const upsert = async (abs: string): Promise<void> => {
    if (!isNote(abs) || vault !== root) return
    try {
      const content = await fs.readFile(abs, 'utf8')
      if (lastWritten.get(abs) === content) return
      send({ type: 'upsert', path: toRel(abs), content })
    } catch {
      /* file vanished between the event and the read */
    }
  }
  watcher
    .on('add', upsert)
    .on('change', upsert)
    .on('unlink', (abs) => {
      if (!isNote(abs) || vault !== root) return
      lastWritten.delete(abs)
      send({ type: 'remove', path: toRel(abs) })
    })
    .on('addDir', (abs) => vault === root && abs !== root && send({ type: 'addDir', path: toRel(abs) }))
    .on('unlinkDir', (abs) => vault === root && send({ type: 'removeDir', path: toRel(abs) }))
  return scan()
}

function registerIpc(): void {
  ipcMain.handle('vault:load', async () => {
    const dir = vault ?? loadState()
    return dir ? setVault(dir) : null
  })

  ipcMain.handle('vault:pick', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open a folder as a vault',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || !res.filePaths[0] ? null : setVault(res.filePaths[0])
  })

  ipcMain.handle('note:write', async (_e, rel: string, content: string) => {
    const abs = inVault(rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    lastWritten.set(abs, content)
    await fs.writeFile(abs, content, 'utf8')
  })

  ipcMain.handle('note:rename', async (_e, from: string, to: string) => {
    const a = inVault(from)
    const b = inVault(to)
    if (a.toLowerCase() !== b.toLowerCase() && existsSync(b)) throw new Error('Something with that name already exists there')
    await fs.mkdir(path.dirname(b), { recursive: true })
    await fs.rename(a, b)
    const content = lastWritten.get(a)
    lastWritten.delete(a)
    if (content !== undefined) lastWritten.set(b, content)
  })

  ipcMain.handle('note:delete', async (_e, rel: string) => {
    const abs = inVault(rel)
    lastWritten.delete(abs)
    await shell.trashItem(abs) // recoverable from the system trash
  })

  ipcMain.handle('dir:create', async (_e, rel: string) => {
    await fs.mkdir(inVault(rel), { recursive: true })
  })

  ipcMain.handle('open-external', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1b1a17',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // The app is a single page: never navigate away or open child windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
