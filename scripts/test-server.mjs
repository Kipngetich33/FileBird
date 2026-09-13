// A local OpenSSH server for trying Fly by hand in `npm run dev`.
//
//   npm run test-server -- up       start one (or show the running one)
//   npm run test-server -- status   show connection details
//   npm run test-server -- down     remove it
//
// Same container as the integration tests: bound to 127.0.0.1 only, random
// port, random password, with a fixture folder at /config/fixture.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertDockerAvailable, startSftpServer } from '../test/support/sftp-container.ts'

const run = promisify(execFile)
const PREFIX = 'fly-sftp-manual-'

async function docker(args) {
  const { stdout } = await run('docker', args, { timeout: 60_000 })
  return stdout.trim()
}

async function findRunning() {
  const names = (await docker(['ps', '--filter', `name=${PREFIX}`, '--format', '{{.Names}}'])).split('\n').filter(Boolean)
  if (names.length === 0) return null
  const name = names[0]
  const port = Number((await docker(['port', name, '2222/tcp'])).split('\n')[0].split(':').pop())
  const env = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Env}}', name]))
  const password = env.find((entry) => entry.startsWith('USER_PASSWORD='))?.slice('USER_PASSWORD='.length)
  return { name, host: '127.0.0.1', port, username: 'fly', password }
}

function describe(server) {
  console.log(`
  Host      ${server.host}
  Port      ${server.port}
  Username  ${server.username}
  Password  ${server.password}

  Try /config/fixture: folders, symlinks, a broken link and an unreadable folder.
  Container ${server.name}`)
}

await assertDockerAvailable()

switch (process.argv[2]) {
  case 'up': {
    const existing = await findRunning()
    if (existing) {
      console.log('A test server is already running:')
      describe(existing)
      break
    }
    const server = await startSftpServer('manual')
    await server.buildFixture()
    console.log('Test server started:')
    describe(server)
    console.log('\n  Remove it with: npm run test-server -- down')
    break
  }
  case 'status': {
    const existing = await findRunning()
    if (existing) describe(existing)
    else console.log('No test server is running. Start one with: npm run test-server -- up')
    break
  }
  case 'down': {
    const names = (await docker(['ps', '-a', '--filter', `name=${PREFIX}`, '--format', '{{.Names}}'])).split('\n').filter(Boolean)
    // -v: the image's /config volume would otherwise be left behind.
    for (const name of names) await docker(['rm', '-f', '-v', name])
    console.log(names.length ? `Removed ${names.join(', ')}` : 'No test server was running.')
    break
  }
  default:
    console.log('Usage: npm run test-server -- up | status | down')
    process.exitCode = 1
}
