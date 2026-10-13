/**
 * verify-kitty-alt-screen — the kitty keyboard push must be live on whichever
 * screen dsh-tui is drawing, and must not leak onto the alternate screen
 * after exit.
 *
 * Kitty keyboard flags are per screen: the main and alternate screens keep
 * separate flags and stacks, and DECSET/DECRST 1049 swap between them
 * (kitty spec; xterm.js 6.1 InputHandler — the swap runs even when 1049h is
 * redundant). A push written before ?1049h therefore lands on the MAIN stack
 * and the fullscreen UI runs with kitty off, so Cmd chords, Esc and
 * Option+Backspace arrive in legacy form or not at all (Orca, issue context:
 * Cmd shortcuts dead in Orca panes). The repo's @xterm/headless 6.0.0 has no
 * kitty support, so this replays the stdout bytes through a minimal model of
 * that state machine instead.
 *
 * Covers:
 *   A. fullscreen mount → alternate screen has flags=1;
 *   B. the self-heal alt-screen re-entry keeps flags=1;
 *   C. unmount pops the alternate stack before leaving it, so no flags=1 are
 *      left for the next alt-screen app in the pane (vim, less, …);
 *   D. inline mode: an alt-screen view opening/closing gets kitty inside and
 *      hands the main screen back with its own push intact.
 *
 * Run: node --import tsx/esm scripts/verify-kitty-alt-screen.tsx
 */
import { PassThrough } from 'node:stream'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.TERM_PROGRAM = 'Orca'
process.env.TERM = 'xterm-256color'
delete process.env.WT_SESSION

const { default: React, useEffect, useState } = await import('react')
const { AlternateScreen, render, Text, useInput } = await import('../src/ui.js')
const { default: instances } = await import('../src/ink/instances.js')
const { settled, sleep } = await import('./lib/term-test.mjs')

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** Kitty keyboard state as xterm.js 6.1 keeps it (per-screen flags+stacks). */
class KittyScreens {
  alt = false
  flags = 0
  mainFlags = 0
  altFlags = 0
  mainStack: number[] = []
  altStack: number[] = []

  feed(bytes: string): void {
    for (const m of bytes.matchAll(/\x1b\[(\?1049[hl]|>(\d*)u|<(\d*)u)/gu)) {
      const seq = m[1]!
      if (seq === '?1049h') {
        this.mainFlags = this.flags
        this.flags = this.altFlags
        this.alt = true
      } else if (seq === '?1049l') {
        this.altFlags = this.flags
        this.flags = this.mainFlags
        this.alt = false
      } else if (seq.startsWith('>')) {
        const stack = this.alt ? this.altStack : this.mainStack
        stack.push(this.flags)
        this.flags = Number(m[2] || 0)
      } else {
        const stack = this.alt ? this.altStack : this.mainStack
        const count = Math.max(1, Number(m[3] || 1))
        for (let i = 0; i < count && stack.length > 0; i++) this.flags = stack.pop()!
        if (stack.length === 0) this.flags = 0
      }
    }
  }

  /** Flags the alternate screen would start with on the next ?1049h. */
  get nextAltFlags(): number {
    return this.alt ? this.flags : this.altFlags
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

/** A TTY stdout whose async writes and sync (fd) writes land in one file in
 *  order, like a real pty — unmount's cleanup uses writeSync(fd). */
function fileTTY(path: string): { stdout: NodeJS.WriteStream; read: () => string; close: () => void } {
  writeFileSync(path, '')
  const fd = openSync(path, 'a')
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough
  Object.assign(stream, { isTTY: true, columns: 80, rows: 24 })
  Object.defineProperty(stream, 'fd', { value: fd, configurable: true })
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    writeFileSync(fd, String(chunk))
    const cb = rest.find(arg => typeof arg === 'function') as (() => void) | undefined
    cb?.()
    return true
  }) as typeof stream.write
  return { stdout: stream, read: () => readFileSync(path, 'utf8'), close: () => closeSync(fd) }
}

function Keys(): React.ReactNode {
  useInput(() => {})
  return <Text>keys</Text>
}

// ── A–C. fullscreen ──────────────────────────────────────────────────────
{
  const tty = fileTTY(join(tmpdir(), `dsh-tui-kitty-alt-${process.pid}-a.out`))
  const instance = await render(<AlternateScreen><Keys /></AlternateScreen>, {
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stdout: tty.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await settled(() => tty.read().includes('\x1b[?1049h') && tty.read().includes('\x1b[>1u'))
  await sleep(50) // 固定窗:探针 首帧后不得再有改写备屏 flags 的写入
  const mounted = new KittyScreens()
  mounted.feed(tty.read())
  check('A. fullscreen: the alternate screen has kitty flags=1', mounted.alt && mounted.flags === 1,
    JSON.stringify(tty.read().match(/\x1b\[(\?1049[hl]|[<>]\d*u)/gu)))

  const ink = instances.get(tty.stdout) as unknown as { reassertTerminalModes(includeAltScreen?: boolean): void }
  const beforeHeal = tty.read().length
  ink.reassertTerminalModes(true)
  await settled(() => tty.read().indexOf('\x1b[?1049h', beforeHeal) !== -1)
  const healed = new KittyScreens()
  healed.feed(tty.read())
  check('B. alt-screen self-heal re-entry keeps kitty flags=1', healed.alt && healed.flags === 1)

  const beforeExit = tty.read().length
  instance.unmount()
  await sleep(50) // 固定窗:pacing 让 AlternateScreen 的 React 清理写完退出序列
  tty.close()
  const exitBytes = tty.read().slice(beforeExit)
  const exited = new KittyScreens()
  exited.feed(tty.read())
  // The synchronous unmount cleanup must pop the ALTERNATE stack while it is
  // still active, i.e. right before its ?1049l. (A bare unmount() then lets
  // <AlternateScreen>'s React cleanup write a second, redundant ?1049l, which
  // xterm.js answers with another flag swap — pre-existing; the plugin's exit
  // funnel detaches first and ends with its own pop after its ?1049l, so the
  // main screen's end state belongs to that path, not this one.)
  check('C. unmount pops the alternate kitty stack before leaving it',
    exitBytes.includes('\x1b[<u\x1b[?1049l'), JSON.stringify(exitBytes.match(/\x1b\[(\?1049[hl]|[<>]\d*u)/gu)))
  check('C2. exit leaves no kitty flags for the next alt-screen app', exited.nextAltFlags === 0 && exited.altStack.length === 0)
}

// ── D. inline with an alt-screen view ────────────────────────────────────
{
  let setOpen: (open: boolean) => void = () => {}
  function Inline(): React.ReactNode {
    const [open, setOpenState] = useState(false)
    useEffect(() => { setOpen = setOpenState }, [])
    return open ? <AlternateScreen><Keys /></AlternateScreen> : <Keys />
  }
  const tty = fileTTY(join(tmpdir(), `dsh-tui-kitty-alt-${process.pid}-d.out`))
  const instance = await render(<Inline />, {
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stdout: tty.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await settled(() => tty.read().includes('\x1b[>1u'))
  await sleep(50) // 固定窗:pacing 等 Inline 的 effect 把 setOpen 挂出来
  setOpen(true)
  await settled(() => /\x1b\[\?1049h[^]*\x1b\[>1u/u.test(tty.read()))
  const opened = new KittyScreens()
  opened.feed(tty.read())
  check('D. inline alt-screen view gets kitty flags=1', opened.alt && opened.flags === 1)
  setOpen(false)
  await settled(() => tty.read().includes('\x1b[?1049l'))
  await sleep(50) // 固定窗:探针 退出备屏后不得再有改写主屏 flags 的写入
  const closed = new KittyScreens()
  closed.feed(tty.read())
  check('D2. closing the view restores the main screen push', !closed.alt && closed.flags === 1)
  check('D3. closing the view drains the alternate stack', closed.nextAltFlags === 0 && closed.altStack.length === 0)
  instance.unmount()
  tty.close()
}

if (failures > 0) {
  console.error(`verify-kitty-alt-screen: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-kitty-alt-screen OK')
process.exit(0)
