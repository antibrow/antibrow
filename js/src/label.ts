/**
 * Floating label pinned to the top of the page, so a window can be told apart
 * at a glance. `document.title` is deliberately left alone, so the profile name
 * never leaks into the page title.
 *
 * The label used to be shipped as generated JS source with the caller's text
 * and colour spliced in. That form had two problems: the colour was never
 * escaped at all, so a crafted `color` executed as code in every page (reachable
 * from MCP, where an agent chooses the value), and static analysers reasonably
 * read "build a script string, then evaluate it" as dynamic code generation.
 * Both go away by passing the values to Playwright as a serialised argument.
 */

// `installLabel` runs inside the page, not in Node. The project's `lib` is
// Node-only (see tsconfig), so the browser globals it touches are declared here,
// file-scoped, rather than pulled in program-wide.
declare const document: any
declare const window: any

export interface LabelOptions {
  labelText: string
  bgColor: string
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const DEFAULT_COLOR = '#333333'

/**
 * Normalise a label + colour into the argument for `installLabel`, or null when
 * there is no label to draw.
 *
 * The colour is validated rather than trusted: it reaches `style.cssText`, so a
 * value that is not a plain 6-digit hex falls back to the default instead of
 * being passed through.
 */
export function labelOptions(label: string, color?: string): LabelOptions | null {
  if (!label) return null
  return {
    labelText: label,
    bgColor: color && HEX_COLOR.test(color) ? color : DEFAULT_COLOR,
  }
}

/**
 * Draw the label. Runs inside the page, so it has to stay self-contained:
 * Playwright serialises it with Function.prototype.toString and no closure
 * variable survives that.
 */
export function installLabel(opts: LabelOptions): void {
  const labelText = opts.labelText
  const bgColor = opts.bgColor

  function createLabel(): void {
    if (window !== window.top) return
    if (document.getElementById('__anti-detect-label')) return

    const el = document.createElement('div')
    el.id = '__anti-detect-label'
    el.textContent = labelText

    // Text colour follows the background luminance.
    const r = parseInt(bgColor.slice(1, 3), 16) || 51
    const g = parseInt(bgColor.slice(3, 5), 16) || 51
    const b = parseInt(bgColor.slice(5, 7), 16) || 51
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const textColor = luminance > 0.5 ? '#000000' : '#ffffff'

    el.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'padding: 2px 12px',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 11px',
      'font-weight: 500',
      'line-height: 18px',
      'color: ' + textColor,
      'background-color: ' + bgColor,
      'border-bottom-left-radius: 4px',
      'border-bottom-right-radius: 4px',
      'box-shadow: 0 1px 3px rgba(0,0,0,0.2)',
      'pointer-events: none',
      'user-select: none',
      'white-space: nowrap',
      'opacity: 0.85',
      'transition: opacity 0.2s',
    ].join('; ')

    const target = document.body || document.documentElement
    if (target) target.appendChild(el)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createLabel)
  } else {
    createLabel()
  }

  // Retry on load in case DOMContentLoaded was missed.
  window.addEventListener('load', createLabel)
}
