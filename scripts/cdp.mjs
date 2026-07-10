/* Minimal Chrome DevTools Protocol driver — zero dependency (node ≥22 has a
   global WebSocket). Replaces the --dump-dom timing hacks: evaluate arbitrary
   expressions (awaitPromise supported) against a really-loaded page, poll for
   readiness, then tear the browser down (SIGKILL — headless Chrome ignores
   SIGTERM). Used by scripts/e2e.mjs. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const CHROME = existsSync(CHROME_MAC) ? CHROME_MAC : 'google-chrome'

export async function withBrowser(fn, { timeoutMs = 90_000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'ecc-cdp-'))
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ])
  const killAll = () => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    /* the SIGKILLed Chrome may still be releasing profile files (ENOTEMPTY
       on Linux runners) — retry briefly, then let the OS tmp reaper have it;
       cleanup must never fail the battery */
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profile, { recursive: true, force: true })
        break
      } catch {
        const until = Date.now() + 200
        while (Date.now() < until) {
          /* sync backoff: killAll must stay synchronous (setTimeout handler) */
        }
      }
    }
  }
  const deadline = setTimeout(killAll, timeoutMs)

  try {
    // Chrome prints "DevTools listening on ws://..." on stderr.
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = ''
      proc.stderr.on('data', (d) => {
        buf += String(d)
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) resolve(m[1])
      })
      proc.on('exit', () => reject(new Error('chrome exited before DevTools endpoint')))
    })

    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })

    let nextId = 1
    const pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    }
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })

    /* page driver: navigate a fresh tab, wait for a predicate, evaluate exprs */
    const openPage = async (url) => {
      const { targetId } = await send('Target.createTarget', { url })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      const evaluate = async (expression, { awaitPromise = false } = {}) => {
        const r = await send(
          'Runtime.evaluate',
          { expression, awaitPromise, returnByValue: true },
          sessionId,
        )
        if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
        return r.result?.value
      }
      const waitFor = async (expression, { tries = 60, intervalMs = 250 } = {}) => {
        for (let i = 0; i < tries; i++) {
          try {
            const v = await evaluate(expression)
            if (v !== null && v !== undefined && v !== false) return v
          } catch {
            /* mid-navigation: the execution context can vanish — retry */
          }
          await new Promise((r) => setTimeout(r, intervalMs))
        }
        return null
      }
      const close = () => send('Target.closeTarget', { targetId })
      /* true device emulation (headless --window-size floors at ~500px wide;
         this doesn't) + full-page screenshot via CDP */
      const emulate = ({ width, height, dsf = 2, mobile = true }) =>
        send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile }, sessionId)
      const screenshot = async (path, { fullPage = false } = {}) => {
        const { writeFileSync } = await import('node:fs')
        const params = { format: 'png' }
        if (fullPage) {
          const m = await send('Page.getLayoutMetrics', {}, sessionId)
          const h = Math.min(Math.ceil(m.cssContentSize?.height ?? m.contentSize.height), 8000)
          params.clip = { x: 0, y: 0, width: Math.ceil(m.cssContentSize?.width ?? m.contentSize.width), height: h, scale: 1 }
          params.captureBeyondViewport = true
        }
        const { data } = await send('Page.captureScreenshot', params, sessionId)
        writeFileSync(path, Buffer.from(data, 'base64'))
      }
      return { evaluate, waitFor, close, emulate, screenshot }
    }

    return await fn({ openPage })
  } finally {
    clearTimeout(deadline)
    killAll()
  }
}
