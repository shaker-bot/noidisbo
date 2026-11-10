export interface Snapshot {
  root: string
  notes: { path: string; content: string }[]
  dirs: string[]
}

export type VaultEvent =
  | { type: 'upsert'; path: string; content: string }
  | { type: 'remove'; path: string }
  | { type: 'addDir'; path: string }
  | { type: 'removeDir'; path: string }

export interface Api {
  loadVault(): Promise<Snapshot | null>
  pickVault(): Promise<Snapshot | null>
  writeNote(path: string, content: string): Promise<void>
  /** Rename or move a note or a folder. */
  movePath(from: string, to: string): Promise<void>
  /** Move a note or a folder to the system trash. */
  trashPath(path: string): Promise<void>
  createDir(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  onVaultEvent(cb: (event: VaultEvent) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
