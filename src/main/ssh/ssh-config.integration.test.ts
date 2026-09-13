import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SshConfigImporter } from './ssh-config'

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/** Runs the real OpenSSH client against a fixture config; nothing connects anywhere. */
describe('SshConfigImporter with the real ssh binary', () => {
  let home: string
  let marker: string
  let importer: SshConfigImporter

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'fly-ssh-config-it-'))
    marker = join(home, 'MATCH_EXEC_RAN')
    await mkdir(join(home, '.ssh'), { recursive: true })
    await writeFile(join(home, '.ssh', 'id_web_web.example.org'), 'not a real key, only needs to exist')
    await writeFile(join(home, 'extra.conf'), 'Host included\n  HostName included.example.org\n  User inc\n')
    // Absolute Include: ssh resolves relative ones against the account's real
    // home, which a fixture HOME can't redirect.
    await writeFile(
      join(home, '.ssh', 'config'),
      [
        `Include ${join(home, 'extra.conf')}`,
        'Host web web-alias',
        '  HostName web.example.org',
        '  User deploy',
        '  Port 2200',
        '  IdentityFile ~/.ssh/id_web_%h',
        'Host jumped',
        '  HostName 10.0.0.5',
        '  ProxyJump bastion.example.org',
        'Host *.internal',
        '  User wildcard',
        `Match exec "touch ${marker}"`,
        '  ServerAliveInterval 30'
      ].join('\n')
    )
    importer = new SshConfigImporter({ home, localUser: userInfo().username, localHost: 'laptop' })
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('runs nothing from the config until the user consents', async () => {
    expect(await importer.preview(false, new Set())).toMatchObject({ status: 'needs-consent', commands: 1 })
    expect(await exists(marker)).toBe(false)
  })

  it('resolves hosts with ssh -G once allowed, which is when Match exec runs', async () => {
    const preview = await importer.preview(true, new Set())
    expect(await exists(marker)).toBe(true)
    if (preview.status !== 'ready') throw new Error(preview.status)

    const by = Object.fromEntries(preview.candidates.map((c) => [c.alias, c]))
    expect(Object.keys(by).sort()).toEqual(['included', 'jumped', 'web', 'web-alias'])
    expect(by['web']).toMatchObject({
      host: 'web.example.org',
      username: 'deploy',
      port: 2200,
      privateKeyPath: join(home, '.ssh', 'id_web_web.example.org'),
      keySource: 'configured',
      warnings: []
    })
    expect(by['web-alias']).toMatchObject({ host: 'web.example.org', port: 2200 })
    expect(by['included']).toMatchObject({ host: 'included.example.org', username: 'inc', port: 22 })
    expect(by['jumped']?.warnings.join(' ')).toContain('jump host (bastion.example.org)')
  })
})
