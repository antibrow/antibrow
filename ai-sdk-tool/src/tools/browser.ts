import { tool } from 'ai'
import { z } from 'zod'
import { AntibrowSession } from '../session'

/** Navigate the session's profile. */
export const browserGoto = (session: AntibrowSession) =>
  tool({
    description:
      "Open a URL in the agent's persistent browser profile. Cookies and storage " +
      'from earlier runs are still there, so pages behind a login open signed in.',
    inputSchema: z.object({
      url: z.string().describe('Absolute URL to open, including the scheme.'),
    }),
    execute: async ({ url }) => {
      const page = await session.page()
      const response = await page.goto(url, { waitUntil: 'load' })
      return { status: response?.status() ?? null, title: await page.title(), url: page.url() }
    },
  })

/** Read text off the current page. */
export const browserRead = (session: AntibrowSession) =>
  tool({
    description:
      'Read the visible text of the current page, or of one element when a CSS ' +
      'selector is given. Truncated, so a long page cannot fill the context window.',
    inputSchema: z.object({
      selector: z
        .string()
        .optional()
        .describe('CSS selector to read; omit for the whole page.'),
    }),
    execute: async ({ selector }) => {
      const page = await session.page()
      const text = await page.locator(selector ?? 'body').first().innerText()
      return {
        url: page.url(),
        truncated: text.length > session.readLimit,
        text: text.slice(0, session.readLimit),
      }
    },
  })

/** Click an element and report where the click landed. */
export const browserClick = (session: AntibrowSession) =>
  tool({
    description: 'Click an element on the current page and report the resulting URL.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of the element to click.'),
    }),
    execute: async ({ selector }) => {
      const page = await session.page()
      await page.locator(selector).first().click()
      return { clicked: selector, url: page.url() }
    },
  })

/** Type into an input on the current page. */
export const browserFill = (session: AntibrowSession) =>
  tool({
    description: 'Type text into an input on the current page.',
    inputSchema: z.object({
      selector: z.string().describe('CSS selector of the input to fill.'),
      text: z.string().describe('Text to type into it.'),
    }),
    execute: async ({ selector, text }) => {
      const page = await session.page()
      await page.locator(selector).first().fill(text)
      return { filled: selector, characters: text.length }
    },
  })
