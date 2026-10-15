/**
 * How many terminals one pane may run at once (user request, 2026-10-15: more
 * than one terminal per pane, as tabs).
 *
 * Three, because the remote pane's terminals are all channels on the one
 * connection, and a server allows only so many: OpenSSH's ten, of which
 * browsing and transfers already use up to four. Both panes at the cap is six,
 * inside the main process's own ceiling of eight sessions
 * (`MAX_SESSIONS` in `main/terminal/terminal.service.ts`, the backstop that
 * does not trust the renderer).
 */
export const MAX_TERMINALS_PER_PANE = 3
