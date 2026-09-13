import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react'

interface DialogProps {
  title: string
  tone?: 'default' | 'danger'
  /** Escape and the backdrop both call this. */
  onDismiss: () => void
  children: ReactNode
  actions: ReactNode
}

/**
 * A modal for decisions that must not happen by accident. Focus starts on the
 * element marked `data-autofocus` (the safe choice), so a stray Enter never
 * confirms anything.
 */
export function Dialog({ title, tone = 'default', onDismiss, children, actions }: DialogProps): JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onDismiss()
          }
        }}
        className={`w-full max-w-md rounded-lg border bg-[#11141b] p-5 shadow-2xl ${
          tone === 'danger' ? 'border-red-500/40' : 'border-white/10'
        }`}
      >
        <h2 id={titleId} className={`text-[14px] font-semibold ${tone === 'danger' ? 'text-red-300' : 'text-zinc-100'}`}>
          {title}
        </h2>
        <div className="mt-2 space-y-3 text-[12px] leading-relaxed text-zinc-400">{children}</div>
        <div className="mt-5 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  )
}

export const SECONDARY_BUTTON =
  'rounded-md border border-white/10 px-3 py-1.5 text-[12px] text-zinc-300 transition hover:border-white/20 hover:text-zinc-100 focus:border-sky-500/60 focus:outline-none'

export const PRIMARY_BUTTON =
  'rounded-md bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/50'

export const DANGER_BUTTON =
  'rounded-md bg-red-600/90 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400/50'

export function Fingerprint({ label, algorithm, fingerprint, testId }: { label: string; algorithm: string; fingerprint: string; testId: string }): JSX.Element {
  return (
    <div className="rounded-md border border-white/[0.07] bg-black/30 px-3 py-2">
      <div className="text-[10px] tracking-wide text-zinc-500">
        <span className="uppercase">{label}</span> · <span className="font-mono">{algorithm}</span>
      </div>
      <div data-testid={testId} className="mt-0.5 font-mono text-[12px] break-all text-zinc-100 select-text">
        {fingerprint}
      </div>
    </div>
  )
}
