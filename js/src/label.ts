/**
 * Script that pins a floating label to the top of the page, so a window can be
 * told apart at a glance. `document.title` is deliberately left alone, so the
 * profile name never leaks into the page title.
 */
export function generateLabelScript(label: string, color?: string): string {
  if (!label) return ''

  const bgColor = color || '#333333'
  const escapedLabel = label.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')

  return `
(function() {
  'use strict'

  const labelText = '${escapedLabel}'
  const bgColor = '${bgColor}'


  function createLabel() {

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
    if (target) {
      target.appendChild(el)
    }
  }


  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      createLabel()
    })
  } else {
    createLabel()
  }

  // Retry on load in case DOMContentLoaded was missed.
  window.addEventListener('load', function() {
    createLabel()
  })
})()
`
}
