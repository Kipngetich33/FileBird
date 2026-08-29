import type { JSX } from 'react'
interface CheckRowProps {
  label: string
  detail: string
  ok: boolean
}

export function CheckRow({ label, detail, ok }: CheckRowProps): JSX.Element {
  return (
    <li className="flex items-center gap-3 border-b border-white/[0.04] py-2.5 last:border-b-0">
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}
      >
        {ok ? '✓' : '✕'}
      </span>
      <span className="w-56 shrink-0 text-[13px] text-zinc-300">{label}</span>
      <span className="truncate font-mono text-[11px] text-zinc-500">{detail}</span>
    </li>
  )
}
