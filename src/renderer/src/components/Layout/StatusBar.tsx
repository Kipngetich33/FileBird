import type { JSX } from 'react'
interface StatusBarProps {
  left: string
  right: string
}

export function StatusBar({ left, right }: StatusBarProps): JSX.Element {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-white/[0.06] bg-[#0e1117] px-4 text-[11px] text-zinc-500">
      <span data-testid="status-active-pane">{left}</span>
      <span className="font-mono">{right}</span>
    </footer>
  )
}
