export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') location.href = '/admin'
    const err = data?.error
    throw new AdminApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status})`)
  }
  return data as T
}

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v)
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '')
    } else el.setAttribute(k, v)
  }
  for (const c of children) if (c) el.append(c)
  return el
}

export function fmtDate(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleString() : '-'
}

export function toLocalInput(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null
}

export function toast(message: string, error = false): void {
  const el = h('div', { class: error ? 'toast err' : 'toast', role: 'status' }, message)
  document.body.append(el)
  setTimeout(() => el.remove(), 4000)
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Runs an action and reports failures as a toast; returns whether it succeeded. */
export async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    toast(errMsg(e), true)
    return false
  }
}

export function openDialog(title: string, body: Node, actions: Node[] = []): HTMLDialogElement {
  const dlg = h('dialog', {})
  const close = h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Close')
  dlg.append(h('h2', {}, title), body, h('div', { class: 'actions' }, ...actions, close))
  dlg.addEventListener('close', () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()
  return dlg
}

/** Shows a freshly issued key; the server never returns it again. */
export function showKey(key: string): void {
  const input = h('input', { readonly: true, value: key, class: 'mono', 'aria-label': 'API key' })
  input.addEventListener('focus', () => input.select())
  const copy = h('button', {
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(key)
        toast('Copied')
      } catch {
        input.select()
        toast('Press Ctrl+C to copy', true)
      }
    },
  }, 'Copy')
  openDialog('API key', h('div', {}, h('p', { class: 'warn' }, 'This key is shown only once. Copy it now.'), h('div', { class: 'row' }, input, copy)))
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const ok = h('button', { type: 'button', class: 'danger', onclick: () => { finish(true); dlg.close() } }, 'Confirm')
    const dlg = openDialog('Please confirm', h('p', {}, message), [ok])
    dlg.addEventListener('close', () => finish(false))
  })
}
