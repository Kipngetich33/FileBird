import { useRef, type CSSProperties, type JSX, type PointerEvent } from 'react'
import { appService } from '@renderer/services/app.service'
import { terminalContextMenu } from '@renderer/utils/context-menu'
import { clampRatio, layoutBoxes, type Box, type SplitDirection, type TerminalNode } from '@renderer/utils/terminal-layout'
import { TerminalView } from './TerminalView'

/** Width of the draggable gap between two panes. */
const DIVIDER_PX = 6

/** Percentages from the layout, inset by half a divider so the gap is between the panes. */
function place({ left, top, width, height }: Box, inset: number): CSSProperties {
  return {
    position: 'absolute',
    left: `calc(${left}% + ${left === 0 ? 0 : inset}px)`,
    top: `calc(${top}% + ${top === 0 ? 0 : inset}px)`,
    width: `calc(${width}% - ${(left === 0 ? 0 : inset) + (left + width >= 100 ? 0 : inset)}px)`,
    height: `calc(${height}% - ${(top === 0 ? 0 : inset) + (top + height >= 100 ? 0 : inset)}px)`
  }
}

interface TerminalPanesProps {
  node: TerminalNode
  side: 'local' | 'remote'
  connectionId?: string
  /** False while this tab is hidden; its shells keep running either way. */
  visible: boolean
  fontSize: number
  /** The pane a split or a close would act on. */
  focusedPane: string | null
  /** False once the pane runs as many shells as it may, which greys the menu's items. */
  canSplit: boolean
  onFocusPane: (key: string) => void
  onClosePane: (key: string) => void
  /** Divides the named pane; the right-click menu acts on the one under the pointer. */
  onSplitPane: (key: string, direction: SplitDirection) => void
  onNewTerminal: () => void
  onResize: (splitId: string, ratio: number) => void
}

/**
 * One terminal tab's panes (user request, 2026-10-19: split a terminal, as
 * macOS Terminal does).
 *
 * Every shell is rendered in **one flat, keyed list**, positioned from the
 * layout tree rather than nested inside it. Nesting would move a terminal in
 * the React tree whenever its pane was divided, and React remounts a component
 * that moves — which would end the session and lose the scrollback, exactly
 * what splitting must not do.
 */
export function TerminalPanes({ node, ...rest }: TerminalPanesProps): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const { panes, dividers } = layoutBoxes(node)
  const canClose = panes.length > 1

  async function showMenu(key: string): Promise<void> {
    rest.onFocusPane(key)
    const action = await appService.showContextMenu(terminalContextMenu({ canSplit: rest.canSplit, canClose }))
    switch (action) {
      case 'split-right':
        rest.onSplitPane(key, 'row')
        return
      case 'split-down':
        rest.onSplitPane(key, 'column')
        return
      case 'new-terminal':
        rest.onNewTerminal()
        return
      case 'close-split':
        rest.onClosePane(key)
        return
      default:
        return
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>, id: string, direction: SplitDirection): void {
    const rect = box.current?.getBoundingClientRect()
    if (rect === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const along =
      direction === 'row' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height
    rest.onResize(id, clampRatio(along))
  }

  return (
    <div ref={box} className="relative min-h-0 min-w-0 flex-1">
      {panes.map((pane) => {
        const focused = rest.focusedPane === pane.key
        return (
          <div
            key={pane.key}
            data-pane={pane.key}
            data-focused={(canClose && focused) || undefined}
            style={place(pane, DIVIDER_PX / 2)}
            onContextMenu={(event) => {
              event.preventDefault()
              void showMenu(pane.key)
            }}
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${
              // Which pane the keyboard is in only matters once there are several.
              canClose ? (focused ? 'ring-1 ring-sky-500/40' : 'ring-1 ring-white/[0.04]') : ''
            }`}
          >
            <TerminalView
              side={rest.side}
              {...(rest.connectionId === undefined ? {} : { connectionId: rest.connectionId })}
              cwd={findCwd(node, pane.key)}
              visible={rest.visible}
              fontSize={rest.fontSize}
              onFocus={() => rest.onFocusPane(pane.key)}
            />
            {/* data-close-pane, never data-pane: that attribute marks where a shell
                lives, and anything counting shells would count this button too. */}
            {canClose && (
              <button
                type="button"
                aria-label="Close this split"
                title="Close this split"
                data-testid="pane-split-close"
                data-close-pane={pane.key}
                onClick={() => rest.onClosePane(pane.key)}
                className="absolute top-1 right-2 z-10 rounded px-1 text-[11px] leading-none text-zinc-600 transition hover:bg-white/10 hover:text-zinc-200"
              >
                ×
              </button>
            )}
          </div>
        )
      })}

      {dividers.map((divider) => (
        <div
          key={divider.id}
          role="separator"
          aria-orientation={divider.direction === 'row' ? 'vertical' : 'horizontal'}
          aria-label="Resize split"
          data-testid="split-divider"
          data-direction={divider.direction}
          data-split={divider.id}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => onPointerMove(event, divider.id, divider.direction)}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          style={{
            position: 'absolute',
            left: divider.direction === 'row' ? `calc(${divider.left}% - ${DIVIDER_PX / 2}px)` : `${divider.left}%`,
            top: divider.direction === 'row' ? `${divider.top}%` : `calc(${divider.top}% - ${DIVIDER_PX / 2}px)`,
            width: divider.direction === 'row' ? DIVIDER_PX : `${divider.width}%`,
            height: divider.direction === 'row' ? `${divider.height}%` : DIVIDER_PX
          }}
          className={`z-10 bg-white/[0.06] transition-colors hover:bg-sky-500/40 ${
            divider.direction === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'
          }`}
        />
      ))}
    </div>
  )
}

/** The folder a pane's shell was started in, which stays with its leaf. */
function findCwd(node: TerminalNode, key: string): string | null {
  if (node.kind === 'leaf') return node.key === key ? node.cwd : null
  return findCwd(node.first, key) ?? findCwd(node.second, key)
}
