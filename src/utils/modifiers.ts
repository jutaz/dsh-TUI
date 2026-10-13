/**
 * Cross-platform modifier-key helpers. Windows/Linux muscle memory uses
 * Ctrl+<key>; on macOS the same action maps to Cmd+<key>. Terminals deliver
 * Cmd as the `super` flag (kitty CSI-u / xterm modifyOtherKeys); Ctrl keeps
 * working everywhere, so `isMod` accepts either.
 *
 * The alias is not gated on the HOST platform: the keyboard belongs to the
 * client terminal, not to the machine dsh-tui runs on. A Mac driving a Linux
 * dsh-tui (Orca's headless runtime, ssh from iTerm2/Ghostty) sends Cmd as
 * super just the same. Elsewhere super only arrives through the kitty
 * protocol and desktop window managers usually grab the Super key first.
 */

/** Whether a Cmd (`super`) keypress counts as the primary modifier. */
export const primaryAcceptsSuper = true

/** True when the key event carries the "primary" modifier (Ctrl or Cmd). */
export function isMod(key: { ctrl?: boolean; super?: boolean }): boolean {
  return !!key.ctrl || (primaryAcceptsSuper && !!key.super)
}

/**
 * Display prefix for shortcut labels: "ctrl+" everywhere, e.g.
 * `${modLabel}o`. Cmd is only a matching alias (see isMod); most
 * terminals never deliver it, so a ⌘ hint would be dead (#640).
 */
export const modLabel = 'ctrl+'

/**
 * Modal-confirm guard. Since #110 the input pipeline can deliver Enter WITH
 * modifiers: Option+Enter arrives as meta+return (ESC CR), and on
 * extended-keys terminals (kitty CSI-u / modifyOtherKeys) Shift/Ctrl+Enter
 * arrive as return+modifier. A bare `key.return` in a decision dialog would
 * let those commit by accident — approving a permission escalation or
 * confirming an irreversible session delete when the user only wanted a
 * newline. Only a modifier-free Enter may commit a modal.
 */
export function isPlainReturn(key: {
  return?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}): boolean {
  return !!key.return && !key.ctrl && !key.meta && !key.shift && !key.super
}

/**
 * Modal Enter recognition across parsed key events and Windows ConPTY's raw
 * CR/LF fallback. PromptInput already handled both forms; shared modal
 * pickers must do the same or their UI can render while Enter appears inert.
 */
export function isPlainReturnInput(
  input: string,
  key: Parameters<typeof isPlainReturn>[0] & { isPasted?: boolean },
): boolean {
  // Bracketed paste can deliver a chunk that is all line breaks — that is
  // pasted content, not an Enter press, and must never confirm a modal.
  // Checked FIRST: a paste chunk may even carry the return flag.
  if (key.isPasted === true) return false
  if (isPlainReturn(key)) return true
  return /^[\r\n]+$/u.test(input)
    && !key.ctrl && !key.meta && !key.shift && !key.super
}
