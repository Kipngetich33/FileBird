/**
 * How many shells one pane may run at once, counting every tab and every split
 * (user requests, 2026-10-15: terminals as tabs; 2026-10-19: splitting a tab).
 *
 * The two sides differ because their limits are different things. A remote
 * shell is a channel on the one SSH connection, and a server allows only so
 * many: OpenSSH's ten, of which browsing takes one and transfers up to four, so
 * four shells leaves a channel spare. A local shell is just a process, with no
 * such ceiling; eight is a generous stopping point rather than a protocol one.
 *
 * The main process keeps its own caps as the backstop and does not trust these
 * (`MAX_SESSIONS`, `MAX_SESSIONS_PER_CONNECTION` in `main/terminal/terminal.service.ts`).
 */
export const MAX_TERMINALS_PER_PANE = { local: 8, remote: 4 } as const

export const maxTerminalsFor = (side: 'local' | 'remote'): number => MAX_TERMINALS_PER_PANE[side]
