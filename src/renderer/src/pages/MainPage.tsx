import type { JSX } from 'react'
import { useSystemInfo } from '@renderer/hooks/useSystemInfo'
import { CheckRow } from '@renderer/components/CheckRow'
import { PingTester } from '@renderer/components/PingTester'

/** True when Node globals are absent — i.e. context isolation is doing its job. */
function nodeIsHidden(): boolean {
  const scope = window as unknown as Record<string, unknown>
  return (
    scope['require'] === undefined &&
    scope['process'] === undefined &&
    scope['module'] === undefined
  )
}

export function MainPage(): JSX.Element {
  const { versions, error, loading, reload } = useSystemInfo()

  return (
    <main className="flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-3xl space-y-7">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-zinc-100">
            Milestone 1 — Application Foundation
          </h1>
          <p className="mt-1 text-[13px] text-zinc-500">
            Electron shell, React renderer, TypeScript, and a secured IPC bridge.
          </p>
        </div>

        <section className="rounded-lg border border-white/[0.07] bg-[#11141b] p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[12px] font-semibold tracking-wide text-zinc-400 uppercase">
              Architecture checks
            </h2>
            <button
              onClick={reload}
              className="rounded border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-200"
            >
              Re-run
            </button>
          </div>

          {error !== null ? (
            <p className="mt-3 rounded-md border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300">
              {error.message}
            </p>
          ) : (
            <ul className="mt-2">
              <CheckRow
                label="React renderer mounted"
                detail="this component rendered"
                ok
              />
              <CheckRow
                label="Preload bridge exposed"
                detail={typeof window.api === 'object' ? 'window.api available' : 'missing'}
                ok={typeof window.api === 'object'}
              />
              <CheckRow
                label="Node hidden from renderer"
                detail="require / process / module are undefined"
                ok={nodeIsHidden()}
              />
              <CheckRow
                label="IPC round trip"
                detail={
                  loading
                    ? 'calling system:get-version…'
                    : versions !== null
                      ? 'system:get-version returned'
                      : 'no response'
                }
                ok={versions !== null}
              />
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-white/[0.07] bg-[#11141b] p-5">
          <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-zinc-400 uppercase">
            IPC round trip
          </h2>
          <PingTester />
        </section>

        <section className="rounded-lg border border-white/[0.07] bg-[#11141b] p-5">
          <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-zinc-400 uppercase">
            Runtime
          </h2>
          {versions === null ? (
            <p className="text-[12px] text-zinc-500">{loading ? 'Loading…' : 'Unavailable'}</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3">
              {(
                [
                  ['App', versions.app],
                  ['Electron', versions.electron],
                  ['Chromium', versions.chrome],
                  ['Node', versions.node],
                  ['V8', versions.v8],
                  ['Platform', `${versions.platform}/${versions.arch}`]
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] tracking-wide text-zinc-600 uppercase">{label}</dt>
                  <dd className="font-mono text-[12px] text-zinc-300 select-text">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <p className="text-[12px] text-zinc-600">
          Next: Milestone 2 — local file browser over IPC.
        </p>
      </div>
    </main>
  )
}
