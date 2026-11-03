/**
 * Structural declarations of the host surfaces this plugin uses.
 *
 * **No `@deepseek-ai/*` import, not a value import and not a peer.** A plugin
 * built out of the workspace cannot depend on the harness's type packages, and a
 * structural declaration is what lets `tsc --noEmit` check this half anyway. The
 * sibling `dsh-lvl1-gate` does the same thing for the same reason
 * (`plugins-src/dsh-lvl1-gate/src/types.ts`), and this file follows it.
 *
 * The route-handler signature is the REAL one, read from the harness rather than
 * assumed: `packages/host/webserver/src/index.ts:52` declares
 * `handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>`
 * under the module header *"Route handlers retain direct response ownership."*
 * It is the node:http `(req, res)` pair — NOT the Web Fetch `Request`/`Response`
 * API. Writing the Fetch shape here would typecheck against a local shim and
 * fail at runtime, which is the one failure class a structural shim can hide, so
 * it is stated explicitly.
 *
 * @module dsh-meta-research/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The route-registration surface, structurally. */
export interface WebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The logger subset used here. */
export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** The Cordis plugin context this half needs. */
export interface HostContext {
  readonly webServer: WebServer
  readonly logger: Logger
  /**
   * Register a disposal callback.
   *
   * Route registration goes through this wrapper because `webServer.register`
   * only RETURNS a disposer (`packages/host/webserver/src/index.ts:366-373`); it
   * does not register one on the context. Calling `register` bare would leave the
   * route table entry behind after an unload or hot reload.
   *
   * @param callback - registers the contribution and returns its disposer.
   * @param label - diagnostic name for the effect.
   */
  effect(callback: () => () => void, label?: string): void
}
