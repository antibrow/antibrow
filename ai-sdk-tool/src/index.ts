import { AntibrowSession, type AntibrowSessionOptions } from './session'
import { browserClick, browserFill, browserGoto, browserRead } from './tools/browser'

export { AntibrowSession, type AntibrowSessionOptions }
export { browserGoto, browserRead, browserClick, browserFill }

/**
 * Four browser tools sharing one persistent AntiBrow profile.
 *
 * ```ts
 * const browser = antibrowTools({ profile: 'research-01' })
 * try {
 *   const { text } = await generateText({
 *     model: gateway('openai/gpt-5-mini'),
 *     prompt: 'Open example.com and tell me the heading.',
 *     tools: browser.tools,
 *     stopWhen: stepCountIs(5),
 *   })
 * } finally {
 *   await browser.close()
 * }
 * ```
 *
 * Close it in a `finally`: a closed browser leaves nothing behind, an abandoned
 * one is a whole Chromium still running.
 */
export function antibrowTools(options: AntibrowSessionOptions = {}) {
  const session = new AntibrowSession(options)
  return {
    session,
    tools: {
      browserGoto: browserGoto(session),
      browserRead: browserRead(session),
      browserClick: browserClick(session),
      browserFill: browserFill(session),
    },
    close: () => session.close(),
  }
}
