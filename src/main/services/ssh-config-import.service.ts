import type { ConnectionSummary, ImportPreview } from '../../shared/types/connections'
import { AppError } from '../errors'
import { createLogger } from '../logger'
import type { SshConfigImporter } from '../ssh/ssh-config'
import type { ConnectionProfilesService } from './connection-profiles.service'
import { APP_NAME } from '../../shared/constants/app'

const log = createLogger('ssh-config')

/** Turns chosen ~/.ssh/config hosts into ordinary, editable saved connections. */
export class SshConfigImportService {
  private readonly importer: SshConfigImporter
  private readonly profiles: ConnectionProfilesService

  constructor(importer: SshConfigImporter, profiles: ConnectionProfilesService) {
    this.importer = importer
    this.profiles = profiles
  }

  async preview(allowCommands: boolean): Promise<ImportPreview> {
    return this.importer.preview(allowCommands, await this.importedAliases())
  }

  /**
   * Re-resolves the chosen aliases itself rather than trusting host details
   * sent back from the renderer.
   */
  async import(aliases: string[], allowCommands: boolean): Promise<ConnectionSummary[]> {
    const preview = await this.preview(allowCommands)
    if (preview.status === 'needs-consent') {
      throw new AppError('INVALID_INPUT', `Confirm that ${APP_NAME} may run the commands in your SSH config first.`)
    }
    if (preview.status === 'no-config') {
      throw new AppError('SSH_CONFIG_UNAVAILABLE', `There's no SSH config at ${preview.configPath}.`)
    }

    const created: ConnectionSummary[] = []
    for (const alias of new Set(aliases)) {
      const candidate = preview.candidates.find((c) => c.alias === alias)
      if (candidate === undefined || candidate.alreadyImported) continue
      created.push(
        await this.profiles.create(
          {
            name: alias,
            host: candidate.host,
            port: candidate.port,
            username: candidate.username,
            auth:
              candidate.privateKeyPath === null
                ? { type: 'password' }
                : { type: 'privateKey', privateKeyPath: candidate.privateKeyPath }
          },
          { kind: 'ssh-config', alias }
        )
      )
    }
    log.info('Imported hosts from SSH config', { count: created.length })
    return created
  }

  private async importedAliases(): Promise<Set<string>> {
    const profiles = await this.profiles.list()
    return new Set(profiles.flatMap((profile) => (profile.importedFrom === undefined ? [] : [profile.importedFrom.alias])))
  }
}
