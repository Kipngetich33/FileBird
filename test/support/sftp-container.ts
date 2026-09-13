import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { promisify } from 'node:util'

/**
 * A real OpenSSH server in a throwaway container, for integration and smoke
 * tests (spec section 19). Requires Docker via Colima: `colima start fly`.
 *
 * Each server is bound to 127.0.0.1 on a random port with a random password,
 * so nothing is reachable from the network and runs never collide.
 */

const run = promisify(execFile)

export const SFTP_IMAGE = 'linuxserver/openssh-server:10.3_p1-r1-ls236'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function docker(args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run('docker', args, { timeout })
  return stdout.trim()
}

export async function assertDockerAvailable(): Promise<void> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 15_000)
  } catch {
    throw new Error('Docker is not available. Start the test VM first: colima start fly')
  }
}

/** Resolves once something on the port speaks SSH (not merely accepts TCP). */
async function waitForSshBanner(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      const done = (result: boolean): void => {
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(1_000, () => done(false))
      socket.once('data', (data) => done(data.toString('latin1').startsWith('SSH-2.0')))
      socket.once('error', () => done(false))
      // While the container starts, Docker's port forwarder accepts and then
      // closes without a byte; without this the probe would wait forever.
      socket.once('close', () => done(false))
    })
    if (ok) return
    await sleep(250)
  }
  throw new Error(`sshd on port ${port} did not become ready within ${timeoutMs} ms`)
}

export interface SftpTestServer {
  readonly name: string
  readonly host: '127.0.0.1'
  readonly port: number
  readonly username: 'fly'
  readonly password: string
  /** The user's home directory, which is also realpath('.') after login. */
  readonly home: '/config'
  exec(script: string): Promise<string>
  /** Builds /config/fixture: folders, sized files, symlinks, a broken link, an unreadable folder. */
  buildFixture(): Promise<void>
  /** Prepends sshd settings (the first value wins in sshd_config) and restarts sshd only. */
  configureSshd(lines: string[]): Promise<void>
  /** Replaces every host key, as a reinstalled or impersonated server would present. */
  rotateHostKeys(): Promise<void>
  /** OpenSSH's own view of the host key fingerprints, via ssh-keyscan and ssh-keygen. */
  keyscanFingerprints(): Promise<string[]>
  /** Ends every open SSH session from the server side, like a server restart would. */
  killSessions(): Promise<void>
  /** Adds an OpenSSH public key line to the user's authorized_keys. */
  authorizeKey(publicKey: string): Promise<void>
  pause(): Promise<void>
  unpause(): Promise<void>
  remove(): Promise<void>
}

export interface SftpServerOptions {
  /** false makes the server key-only, as most cloud servers are. Default true. */
  passwordAccess?: boolean
  /** A world-writable tmpfs of this many bytes at /tiny, for "disk full" tests. */
  tinyDiskBytes?: number
}

/**
 * Removal always passes `-v`: the image declares `VOLUME /config`, so each
 * container gets an anonymous volume that `docker rm -f` alone leaves behind
 * (107 of them, 19 GB, had filled the VM's disk by Milestone 10).
 */
export async function startSftpServer(label: string, options: SftpServerOptions = {}): Promise<SftpTestServer> {
  await assertDockerAvailable()

  const name = `fly-sftp-${label}-${process.pid}-${Date.now()}`
  const password = `pw-${randomBytes(12).toString('hex')}`
  const passwordAccess = options.passwordAccess ?? true

  await docker(
    [
      'run', '-d', '--rm', '--name', name,
      '-p', '127.0.0.1::2222',
      ...(options.tinyDiskBytes === undefined
        ? []
        : ['--mount', `type=tmpfs,destination=/tiny,tmpfs-size=${options.tinyDiskBytes},tmpfs-mode=1777`]),
      '-e', 'PUID=1000', '-e', 'PGID=1000', '-e', 'TZ=Etc/UTC',
      '-e', 'USER_NAME=fly', '-e', `USER_PASSWORD=${password}`, '-e', `PASSWORD_ACCESS=${passwordAccess}`,
      SFTP_IMAGE
    ],
    180_000
  )

  let port: number
  try {
    const mapping = await docker(['port', name, '2222/tcp'])
    port = Number(mapping.split('\n')[0]?.split(':').pop())
    if (!Number.isInteger(port)) throw new Error(`Unexpected port mapping: ${mapping}`)
    await waitForSshBanner(port)
  } catch (error) {
    await docker(['rm', '-f', '-v', name]).catch(() => undefined)
    throw error
  }

  const exec = (script: string): Promise<string> => docker(['exec', name, 'sh', '-c', script])

  const restartSshd = async (): Promise<void> => {
    const before = await exec('cat /config/sshd.pid 2>/dev/null || true')
    await exec('s6-svc -r /run/service/svc-openssh-server')
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const now = await exec('cat /config/sshd.pid 2>/dev/null || true')
      if (now !== '' && now !== before) break
      await sleep(200)
    }
    await waitForSshBanner(port)
  }

  return {
    name,
    host: '127.0.0.1',
    port,
    username: 'fly',
    password,
    home: '/config',
    exec,

    async buildFixture() {
      await exec(
        [
          'set -e',
          'cd /config',
          'rm -rf fixture',
          'mkdir -p fixture/alpha fixture/locked',
          'printf hello > fixture/file2.txt',
          ': > fixture/file10.txt',
          ': > fixture/.hidden',
          'ln -s /config/fixture/alpha fixture/link-to-alpha',
          'ln -s /config/fixture/missing fixture/broken-link',
          'chown -R 1000:1000 fixture',
          'chown -h 1000:1000 fixture/link-to-alpha fixture/broken-link',
          'chmod 000 fixture/locked'
        ].join(' && ')
      )
    },

    async configureSshd(lines) {
      for (const line of [...lines].reverse()) {
        await exec(`sed -i '1i ${line}' /config/sshd/sshd_config`)
      }
      await restartSshd()
    },

    async rotateHostKeys() {
      await exec(
        [
          'set -e',
          'cd /config/ssh_host_keys',
          'for f in ssh_host_*_key; do t=${f#ssh_host_}; t=${t%_key}; rm -f "$f" "$f.pub"; ssh-keygen -q -N "" -t "$t" -f "$f"; done',
          'chown 1000:1000 ssh_host_*'
        ].join(' && ')
      )
      await restartSshd()
    },

    async keyscanFingerprints() {
      const { stdout } = await run(
        'sh',
        ['-c', `ssh-keyscan -p ${port} 127.0.0.1 2>/dev/null | ssh-keygen -lf -`],
        { timeout: 15_000 }
      )
      return stdout
        .split('\n')
        .map((line) => line.split(' ')[1])
        .filter((fingerprint): fingerprint is string => fingerprint?.startsWith('SHA256:') === true)
    },

    async killSessions() {
      // Per-connection processes are "sshd-session"; the listener is "sshd.pam".
      // The bracket keeps pkill from matching (and killing) this shell itself.
      await exec("pkill -f '[s]shd-session' || true")
    },

    async authorizeKey(publicKey) {
      // Passed as an environment variable so the key needs no shell quoting.
      await docker([
        'exec', '-e', `FLY_PUBLIC_KEY=${publicKey}`, name, 'sh', '-c',
        [
          'set -e',
          'mkdir -p /config/.ssh',
          'printf "%s\\n" "$FLY_PUBLIC_KEY" >> /config/.ssh/authorized_keys',
          'chown -R 1000:1000 /config/.ssh',
          'chmod 700 /config/.ssh',
          'chmod 600 /config/.ssh/authorized_keys'
        ].join(' && ')
      ])
    },

    pause: async () => {
      await docker(['pause', name])
    },
    unpause: async () => {
      await docker(['unpause', name])
    },
    remove: async () => {
      await docker(['rm', '-f', '-v', name]).catch(() => undefined)
    }
  }
}
