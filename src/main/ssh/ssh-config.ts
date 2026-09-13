import { execFile } from 'node:child_process'
import { access, glob, readFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ImportCandidate, ImportPreview } from '../../shared/types/connections'
import { AppError, errnoOf } from '../errors'
import { createLogger } from '../logger'
import { mapLimit } from '../utils/map-limit'
import { APP_NAME } from '../../shared/constants/app'

const log = createLogger('ssh-config')

/**
 * Reading ~/.ssh/config for a one-way import (Milestone 3, decision D11).
 *
 * Host settings are resolved by OpenSSH itself (`ssh -G`), which applies
 * Include, Match and defaults exactly as `ssh` would. Fly only lists the host
 * aliases (ssh -G can't) and looks for `Match exec`, because ssh -G runs those
 * commands and the user must agree to that first.
 */

/** OpenSSH stops following Include after this depth. */
const MAX_INCLUDE_DEPTH = 16

export interface ConfigLine {
  keyword: string
  args: string[]
}

/** Splits one config line the way OpenSSH does: `Keyword args` or `Keyword=args`, double quotes, # comments. */
export function splitConfigLine(line: string): ConfigLine | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null

  const match = /^([^\s=]+)\s*(?:=\s*|\s+|$)(.*)$/.exec(trimmed)
  if (match === null) return null

  const args: string[] = []
  const rest = match[2] ?? ''
  let index = 0
  while (index < rest.length) {
    while (rest[index] === ' ' || rest[index] === '\t') index += 1
    if (index >= rest.length) break
    if (rest[index] === '#') break
    if (rest[index] === '"') {
      const end = rest.indexOf('"', index + 1)
      args.push(rest.slice(index + 1, end === -1 ? rest.length : end))
      index = end === -1 ? rest.length : end + 1
    } else {
      let end = index
      while (end < rest.length && rest[end] !== ' ' && rest[end] !== '\t') end += 1
      args.push(rest.slice(index, end))
      index = end
    }
  }
  return { keyword: (match[1] ?? '').toLowerCase(), args }
}

export interface ConfigScan {
  /** Concrete host aliases in file order; patterns with *, ? or ! are left out. */
  aliases: string[]
  /** How many `Match` lines use `exec`, which `ssh -G` would run. */
  matchExecCount: number
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** Lists aliases and `Match exec` lines, following Include like OpenSSH does for a user config. */
export async function scanSshConfig(configPath: string, home: string): Promise<ConfigScan> {
  const aliases: string[] = []
  const seen = new Set<string>()
  let matchExecCount = 0

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) return
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (depth > 0 && errnoOf(error) === 'ENOENT') return
      throw error
    }

    for (const raw of text.split(/\r?\n/)) {
      const line = splitConfigLine(raw)
      if (line === null) continue

      if (line.keyword === 'host') {
        for (const pattern of line.args) {
          if (/[*?!]/.test(pattern) || seen.has(pattern)) continue
          seen.add(pattern)
          aliases.push(pattern)
        }
      } else if (line.keyword === 'match') {
        if (line.args.some((arg) => arg.toLowerCase() === 'exec' || arg.toLowerCase() === '!exec')) matchExecCount += 1
      } else if (line.keyword === 'include') {
        for (const arg of line.args) {
          const expanded = expandHome(arg, home)
          // Relative includes in a user config are relative to ~/.ssh.
          const pattern = isAbsolute(expanded) ? expanded : join(home, '.ssh', expanded)
          const matches: string[] = []
          for await (const file of glob(pattern)) matches.push(file)
          for (const file of matches.sort()) await visit(file, depth + 1)
        }
      }
    }
  }

  await visit(configPath, 0)
  return { aliases, matchExecCount }
}

export interface TokenContext {
  home: string
  localUser: string
  localHost: string
  alias: string
  host: string
  remoteUser: string
  port: number
}

/** Expands the IdentityFile tokens OpenSSH documents; ssh -G prints them unexpanded. */
export function expandIdentityPath(value: string, context: TokenContext): { path: string; unsupported: boolean } {
  let unsupported = false
  const tokens: Record<string, string> = {
    d: context.home,
    u: context.localUser,
    l: context.localHost.split('.')[0] ?? context.localHost,
    L: context.localHost,
    n: context.alias,
    h: context.host,
    r: context.remoteUser,
    p: String(context.port),
    '%': '%'
  }
  const path = expandHome(value, context.home).replace(/%(.)/g, (whole, token: string) => {
    const replacement = tokens[token]
    if (replacement === undefined) {
      unsupported = true
      return whole
    }
    return replacement
  })
  return { path, unsupported }
}

export interface ResolvedHost {
  hostname: string
  user: string
  port: number
  identityFiles: string[]
  proxyJump: string | null
}

/** Reads the `keyword value` lines ssh -G prints. */
export function parseSshG(output: string): ResolvedHost {
  const resolved: ResolvedHost = { hostname: '', user: '', port: 22, identityFiles: [], proxyJump: null }
  for (const line of output.split(/\r?\n/)) {
    const space = line.indexOf(' ')
    if (space === -1) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key === 'hostname') resolved.hostname = value
    else if (key === 'user') resolved.user = value
    else if (key === 'port') resolved.port = Number(value)
    else if (key === 'identityfile') resolved.identityFiles.push(value)
    else if (key === 'proxyjump' && value.toLowerCase() !== 'none') resolved.proxyJump = value
  }
  return resolved
}

export type SshRunner = (args: string[]) => Promise<string>

const runSshBinary: SshRunner = async (args) => {
  try {
    const { stdout } = await promisify(execFile)('ssh', args, { timeout: 10_000, maxBuffer: 1024 * 1024 })
    return stdout
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      throw new AppError('SSH_CONFIG_UNAVAILABLE', "Importing needs the OpenSSH client (ssh), which wasn't found on this computer.")
    }
    throw error
  }
}

export interface SshConfigImporterOptions {
  home: string
  localUser: string
  localHost: string
  runSsh?: SshRunner
  fileExists?: (path: string) => Promise<boolean>
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class SshConfigImporter {
  private readonly options: SshConfigImporterOptions
  private readonly runSsh: SshRunner
  private readonly fileExists: (path: string) => Promise<boolean>

  constructor(options: SshConfigImporterOptions) {
    this.options = options
    this.runSsh = options.runSsh ?? runSshBinary
    this.fileExists = options.fileExists ?? defaultFileExists
  }

  get configPath(): string {
    return join(this.options.home, '.ssh', 'config')
  }

  /**
   * Lists importable hosts. Runs nothing from the config unless `allowCommands`
   * is true, because resolving hosts with `ssh -G` executes `Match exec` lines.
   */
  async preview(allowCommands: boolean, alreadyImported: ReadonlySet<string>): Promise<ImportPreview> {
    const configPath = this.configPath
    if (!(await this.fileExists(configPath))) return { status: 'no-config', configPath }

    const scan = await scanSshConfig(configPath, this.options.home)
    if (scan.matchExecCount > 0 && !allowCommands) {
      return { status: 'needs-consent', configPath, commands: scan.matchExecCount }
    }

    // Every host prints OpenSSH's default key names when none is configured;
    // an empty config shows exactly which names those are.
    const defaults = parseSshG(await this.runSsh(['-F', devNull, '-G', 'fly-import-defaults'])).identityFiles

    const resolved = await mapLimit(scan.aliases, 4, async (alias) => {
      try {
        return await this.candidate(alias, configPath, defaults, alreadyImported)
      } catch (error) {
        if (error instanceof AppError) throw error
        log.warn('Skipped a host ssh could not resolve', { error: error instanceof Error ? error.message : String(error) })
        return null
      }
    })
    return { status: 'ready', configPath, candidates: resolved.filter((c): c is ImportCandidate => c !== null) }
  }

  private async candidate(
    alias: string,
    configPath: string,
    defaults: string[],
    alreadyImported: ReadonlySet<string>
  ): Promise<ImportCandidate | null> {
    // `--` so an alias can never be read as an ssh option.
    const host = parseSshG(await this.runSsh(['-F', configPath, '-G', '--', alias]))
    if (host.hostname === '' || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) return null

    const warnings: string[] = []
    const context: TokenContext = { ...this.options, alias, host: host.hostname, remoteUser: host.user, port: host.port }
    const expand = (value: string): string => {
      const { path, unsupported } = expandIdentityPath(value, context)
      if (unsupported) warnings.push(`The key path "${value}" uses a token ${APP_NAME} can't expand.`)
      return path
    }

    const configured = host.identityFiles.filter((file) => !defaults.includes(file)).map(expand)
    let privateKeyPath: string | null = null
    let keySource: ImportCandidate['keySource'] = null

    if (configured.length > 0) {
      keySource = 'configured'
      privateKeyPath = (await this.firstExisting(configured)) ?? configured[0] ?? null
      if (privateKeyPath !== null && !(await this.fileExists(privateKeyPath))) {
        warnings.push(`Key file not found: ${privateKeyPath}`)
      }
    } else {
      const fallback = await this.firstExisting(defaults.map(expand))
      if (fallback !== null) {
        keySource = 'default'
        privateKeyPath = fallback
      }
    }

    if (host.proxyJump !== null) {
      warnings.push(`Connects through a jump host (${host.proxyJump}), which ${APP_NAME} doesn't support yet.`)
    }

    return {
      alias,
      host: host.hostname,
      port: host.port,
      username: host.user,
      privateKeyPath,
      keySource,
      warnings,
      alreadyImported: alreadyImported.has(alias)
    }
  }

  private async firstExisting(paths: string[]): Promise<string | null> {
    for (const path of paths) {
      if (await this.fileExists(path)) return path
    }
    return null
  }
}
