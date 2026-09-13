/**
 * Where the renderer may navigate (hardened in Milestone 9). The app is a single
 * page: in development only the Vite dev server's origin is allowed, when
 * packaged only the exact index.html it was loaded from. Any other file: URL —
 * say, a local HTML file — would get the preload bridge, so it is refused.
 */
export type NavigationAllowance = { origin: string } | { exactUrl: string }

export function isAllowedNavigation(url: string, allowance: NavigationAllowance): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if ('origin' in allowance) return target.origin === allowance.origin
  const allowed = new URL(allowance.exactUrl)
  return target.protocol === 'file:' && target.pathname === allowed.pathname
}
