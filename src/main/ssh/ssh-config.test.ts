import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SshConfigImporter,
  expandIdentityPath,
  parseSshG,
  scanSshConfig,
  splitConfigLine,
  type SshRunner
} from './ssh-config'

describe('splitConfigLine', () => {
  it.each([
    ['Host web prod', { keyword: 'host', args: ['web', 'prod'] }],
    ['  HostName=example.com', { keyword: 'hostname', args: ['example.com'] }],
    ['IdentityFile "~/My Keys/id rsa"', { keyword: 'identityfile', args: ['~/My Keys/id rsa'] }],
    ['Match exec "test -f /tmp/x" host y', { keyword: 'match', args: ['exec', 'test -f /tmp/x', 'host', 'y'] }],
    ['User deploy # trailing comment', { keyword: 'user', args: ['deploy'] }],
    ['\tPort\t2222', { keyword: 'port', args: ['2222'] }]
  ])('%j', (line, expected) => {
    expect(splitConfigLine(line)).toEqual(expected)
  })

  it('ignores blank lines and comments', () => {
    expect(splitConfigLine('')).toBeNull()
    expect(splitConfigLine('   # Host commented-out')).toBeNull()
  })
})

describe('scanSshConfig', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fly-ssh-config-'))
    await mkdir(join(home, '.ssh', 'conf.d'), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('lists concrete aliases in order, skipping patterns and duplicates', async () => {
    await writeFile(join(home, '.ssh', 'config'), ['Host web prod-web', 'Host *.internal !secret.internal', 'Host db?', 'Host web', 'Host db'].join('\n'))
    expect(await scanSshConfig(join(home, '.ssh', 'config'), home)).toEqual({ aliases: ['web', 'prod-web', 'db'], matchExecCount: 0 })
  })

  it('follows Include: relative to ~/.ssh, with ~, globs and absolute paths, and counts Match exec inside them', async () => {
    await writeFile(join(home, '.ssh', 'conf.d', 'b.conf'), 'Host from-glob-b\nMatch exec "true"\n  User x')
    await writeFile(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host from-glob-a')
    await writeFile(join(home, 'absolute.conf'), 'Host from-absolute')
    await writeFile(join(home, '.ssh', 'tilde.conf'), 'Host from-tilde')
    await writeFile(
      join(home, '.ssh', 'config'),
      ['Include conf.d/*.conf', `Include ${join(home, 'absolute.conf')}`, 'Include ~/.ssh/tilde.conf', 'Include missing.conf', 'Host top'].join('\n')
    )

    expect(await scanSshConfig(join(home, '.ssh', 'config'), home)).toEqual({
      aliases: ['from-glob-a', 'from-glob-b', 'from-absolute', 'from-tilde', 'top'],
      matchExecCount: 1
    })
  })

  it('counts Match exec and negated exec, but not other Match criteria', async () => {
    await writeFile(join(home, '.ssh', 'config'), ['Match host x exec "a"', 'Match !exec "b"', 'Match host y user z', 'Match final'].join('\n'))
    expect((await scanSshConfig(join(home, '.ssh', 'config'), home)).matchExecCount).toBe(2)
  })

  it('survives an Include loop', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host loop\nInclude config')
    expect((await scanSshConfig(join(home, '.ssh', 'config'), home)).aliases).toEqual(['loop'])
  })
})

describe('expandIdentityPath', () => {
  const context = { home: '/Users/me', localUser: 'me', localHost: 'laptop.local', alias: 'web', host: 'web.example.com', remoteUser: 'deploy', port: 2200 }

  it.each([
    ['~/.ssh/id_%h', '/Users/me/.ssh/id_web.example.com'],
    ['%d/.ssh/%r@%h-%p', '/Users/me/.ssh/deploy@web.example.com-2200'],
    ['/keys/%u-%l-%n', '/keys/me-laptop-web'],
    ['/keys/100%%', '/keys/100%']
  ])('%s → %s', (value, expected) => {
    expect(expandIdentityPath(value, context)).toEqual({ path: expected, unsupported: false })
  })

  it('flags tokens it cannot expand instead of guessing', () => {
    expect(expandIdentityPath('~/.ssh/id_%C', context)).toEqual({ path: '/Users/me/.ssh/id_%C', unsupported: true })
  })
})

describe('parseSshG', () => {
  it('reads the fields Fly imports, keeping every identity file', () => {
    const output = ['user deploy', 'hostname 203.0.113.10', 'port 2200', 'identityfile ~/.ssh/id_a', 'identityfile ~/.ssh/id_b', 'proxyjump bastion'].join('\n')
    expect(parseSshG(output)).toEqual({ hostname: '203.0.113.10', user: 'deploy', port: 2200, identityFiles: ['~/.ssh/id_a', '~/.ssh/id_b'], proxyJump: 'bastion' })
    expect(parseSshG('hostname h\nproxyjump none').proxyJump).toBeNull()
  })
})

describe('SshConfigImporter (with a stand-in for ssh)', () => {
  const DEFAULTS = ['~/.ssh/id_rsa', '~/.ssh/id_ecdsa', '~/.ssh/id_ed25519']
  let home: string
  let calls: string[][]

  const fakeSsh = (hosts: Record<string, string>): SshRunner => async (args) => {
    calls.push(args)
    const alias = args.at(-1) ?? ''
    if (alias === 'fly-import-defaults') return DEFAULTS.map((f) => `identityfile ${f}`).join('\n')
    const output = hosts[alias]
    if (output === undefined) throw new Error(`unexpected alias ${alias}`)
    return output
  }

  const importer = (hosts: Record<string, string>, existing: string[] = []): SshConfigImporter =>
    new SshConfigImporter({
      home,
      localUser: 'me',
      localHost: 'laptop',
      runSsh: fakeSsh(hosts),
      fileExists: async (path) => path === join(home, '.ssh', 'config') || existing.includes(path)
    })

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fly-importer-'))
    await mkdir(join(home, '.ssh'), { recursive: true })
    calls = []
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('reports a missing config without running ssh', async () => {
    const preview = await new SshConfigImporter({ home: join(home, 'nobody'), localUser: 'me', localHost: 'l', runSsh: fakeSsh({}) }).preview(true, new Set())
    expect(preview.status).toBe('no-config')
    expect(calls).toEqual([])
  })

  it('asks for consent before running ssh on a config with Match exec', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host web\nMatch exec "touch /tmp/should-not-run"')
    expect(await importer({}).preview(false, new Set())).toEqual({ status: 'needs-consent', configPath: join(home, '.ssh', 'config'), commands: 1 })
    expect(calls).toEqual([])
  })

  it('falls back to password login when no configured or default key exists', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host no-key')
    const preview = await importer({ 'no-key': 'hostname d.example\nuser u\nport 22\nidentityfile ~/.ssh/id_rsa' }).preview(false, new Set())
    if (preview.status !== 'ready') throw new Error(preview.status)
    expect(preview.candidates[0]).toMatchObject({ alias: 'no-key', privateKeyPath: null, keySource: null, warnings: [] })
  })

  it('builds candidates: configured, missing and default keys, jump hosts, earlier imports', async () => {
    await writeFile(join(home, '.ssh', 'config'), 'Host with-key missing-key default-key jumped')
    const hosts = {
      'with-key': 'hostname a.example\nuser deploy\nport 2200\nidentityfile ~/.ssh/id_work\nidentityfile ~/.ssh/id_rsa',
      'missing-key': 'hostname b.example\nuser u\nport 22\nidentityfile ~/.ssh/id_gone',
      'default-key': 'hostname c.example\nuser u\nport 22\nidentityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519',
      jumped: 'hostname e.example\nuser u\nport 22\nproxyjump bastion.example'
    }
    const preview = await importer(hosts, [join(home, '.ssh', 'id_work'), join(home, '.ssh', 'id_ed25519')]).preview(false, new Set(['jumped']))
    if (preview.status !== 'ready') throw new Error(preview.status)
    const by = Object.fromEntries(preview.candidates.map((c) => [c.alias, c]))

    expect(by['with-key']).toMatchObject({ host: 'a.example', username: 'deploy', port: 2200, privateKeyPath: join(home, '.ssh', 'id_work'), keySource: 'configured', warnings: [] })
    expect(by['missing-key']).toMatchObject({ privateKeyPath: join(home, '.ssh', 'id_gone'), keySource: 'configured', warnings: [expect.stringContaining('not found')] })
    expect(by['default-key']).toMatchObject({ privateKeyPath: join(home, '.ssh', 'id_ed25519'), keySource: 'default' })
    expect(by['jumped']).toMatchObject({ alreadyImported: true, warnings: [expect.stringContaining('jump host (bastion.example)')] })

    // Every alias is passed after `--`, so it can never be read as an option.
    for (const args of calls.filter((a) => a.at(-1) !== 'fly-import-defaults')) expect(args.at(-2)).toBe('--')
  })
})
