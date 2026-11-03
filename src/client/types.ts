/**
 * The Client half's structural types.
 *
 * No `@deepseek-ai/*` import: the Client context is declared structurally, the same
 * choice the working sibling `dsh-lvl1-gate` makes (`src/client/types.ts`) and for
 * the same reason. A structural declaration also keeps this bundle free of module
 * table entries beyond `react`, which is the one class of client-bundle failure a
 * build cannot catch (`tsdown.config.ts` §purity).
 *
 * @module dsh-meta-research/client/types
 */

import type { ReactElement } from 'react'

/** Translate one key from this plugin's namespace. */
export type Translator = (key: string) => string

/** A locale service, as this half uses it. */
export interface ClientLocale {
  register(ns: string, lang: 'en' | 'zh', dict: Record<string, string>): () => void
  bind(ns: string): Translator
}

/** A slot registration, as this half uses it. */
export interface ClientSlots {
  inject(name: string, callback: () => () => void): void
  register(
    options: Record<string, unknown>,
    component: (props: Record<string, unknown>) => ReactElement | null,
  ): () => void
}

/** The properties every `main` panel receives from the shell. */
export interface PageProps {
  readonly t: Translator
}

/** The Client plugin context. */
export interface ClientContext {
  readonly slots: ClientSlots
  readonly locale: ClientLocale
  effect(callback: () => (() => void) | void, label?: string): void
  readonly logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}
