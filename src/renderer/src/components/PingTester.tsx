import { useState, type FormEvent, type JSX } from 'react'
import type { AppErrorPayload } from '@shared/types/errors'
import { systemService } from '@renderer/services/system.service'

/**
 * Round-trip test for the IPC bridge.
 *
 * Sending an empty message is deliberately allowed here so the main process
 * validator can reject an over-long string — proving that IPC input really is
 * validated rather than trusted.
 */
export function PingTester(): JSX.Element {
  const [message, setMessage] = useState('Hello from React')
  const [reply, setReply] = useState<string | null>(null)
  const [error, setError] = useState<AppErrorPayload | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setPending(true)
    setError(null)
    setReply(null)

    const startedAt = performance.now()
    try {
      const result = await systemService.ping(message)
      const elapsed = (performance.now() - startedAt).toFixed(1)
      setReply(`"${result.message}" · main replied at ${result.receivedAt} · ${elapsed} ms`)
    } catch (cause) {
      setError(cause as AppErrorPayload)
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2">
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message to send through IPC"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-[12px] text-zinc-200 outline-none select-text placeholder:text-zinc-600 focus:border-sky-500/60"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-sky-600 px-4 py-2 text-[12px] font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {reply !== null && (
        <p className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.07] px-3 py-2 font-mono text-[11px] break-all text-emerald-300 select-text">
          {reply}
        </p>
      )}

      {error !== null && (
        <p className="rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-300 select-text">
          <span className="font-mono text-red-400">{error.code}</span> — {error.message}
        </p>
      )}

      <p className="text-[11px] text-zinc-600">
        Try pasting more than 200 characters — the main process rejects it and returns a
        user-friendly error instead of a stack trace.
      </p>
    </form>
  )
}
