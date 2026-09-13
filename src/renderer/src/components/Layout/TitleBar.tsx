import type { JSX } from 'react'
import { APP_NAME } from '@shared/constants/app'
interface TitleBarProps {
  /** macOS uses an inset title bar, so the content needs to clear the traffic lights. */
  isMac: boolean
  status: string
}

export function TitleBar({ isMac, status }: TitleBarProps): JSX.Element {
  return (
    <header
      className={`drag-region flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#11141b] pr-5 ${
        isMac ? 'pl-24' : 'pl-5'
      }`}
    >
      <div className="flex items-baseline gap-2.5">
        <span className="text-[13px] font-semibold tracking-tight text-zinc-100">{APP_NAME}</span>
        <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
          SFTP Client
        </span>
      </div>
      <span className="text-[11px] text-zinc-500">{status}</span>
    </header>
  )
}
