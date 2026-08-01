import { normalizeProjectPath, resolveClipPath } from './project'
import type { TapManager } from './tap'
import type { PlayerManager } from './player'
import type { TransportState } from '../shared/types'

/**
 * Mutable main-process state, threaded through the IPC registrars
 * (`register*Ipc`) instead of module globals. Electron-free, so the path
 * and grant guards are unit-testable.
 */
export class AppContext {
  /**
   * Dir the current project lives in (the .oscproj bundle, or the dir of a
   * legacy flat project.json). Null until a project is opened or saved.
   */
  projectDir: string | null = null

  /**
   * undoSeq of the last saved/loaded doc; log compaction must keep
   * everything past it (boot's redo / crash-recovery tail).
   */
  savedUndoSeq = 0

  // Unsaved-changes guard: the renderer reports dirty through
  // window:setFile; closing a dirty window prompts save/discard/cancel.
  dirtyState = false
  forceClose = false

  tap: TapManager | null = null
  tapError: string | null = null
  player: PlayerManager | null = null
  playerError: string | null = null

  /**
   * Last foreign transport state, kept so a renderer that loads (or
   * reloads) after a change can seed its playhead instead of assuming 0.
   */
  lastTransport: { state: TransportState; at: number } | null = null

  // Project paths the user explicitly granted (CLI arg or a native dialog
  // result). project:save and project:loadPath refuse anything else, so a
  // compromised renderer can't write or read arbitrary locations.
  private grantedPaths = new Set<string>()

  constructor(
    /** cwd when launched from the CLI (per spec). */
    readonly workdir: string,
    /** App-owned files (control socket, undo log, staged recordings). */
    readonly dataDir: string,
    /** Recordings for unsaved projects land here, never in the cwd. */
    readonly stagingDir: string,
    /** e2e: never show a window, steal focus, or open native dialogs. */
    readonly hidden: boolean
  ) {}

  /** Clip files resolve against the project bundle, then staging. */
  resolveClip = (file: string): string =>
    resolveClipPath(this.projectDir ?? this.workdir, this.stagingDir, file)

  /** Roots a renderer-supplied clip path may point into. */
  clipRoots(): (string | null)[] {
    return [this.projectDir ?? this.workdir, this.stagingDir]
  }

  /**
   * The undo log lives in the project bundle; untitled sessions stage it
   * in userData and it moves into the bundle on Save As.
   */
  undoDir(): string {
    return this.projectDir ?? this.dataDir
  }

  grantProjectPath(p: string): string {
    this.grantedPaths.add(normalizeProjectPath(p))
    return p
  }

  requireGranted(p: string): string {
    const projectPath = normalizeProjectPath(p)
    if (!this.grantedPaths.has(projectPath)) {
      throw new Error(`project path not granted by a dialog: ${p}`)
    }
    return projectPath
  }

  requireTap(): TapManager {
    if (!this.tap) throw new Error(this.tapError ?? 'vtr-tap not running')
    return this.tap
  }

  requirePlayer(): PlayerManager {
    if (!this.player) throw new Error(this.playerError ?? 'vtr-player not running')
    return this.player
  }
}
