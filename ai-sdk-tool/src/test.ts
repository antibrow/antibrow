/**
 * Two checks, because a real model call needs a key this machine does not have
 * and the registry asks that the integration be confirmed to work:
 *
 *  1. the tools run for real - a live AntiBrow profile, a real navigation, real text
 *  2. the whole AI SDK tool-call path runs, with a mock model standing in for the
 *     LLM, so the schema, the tool-call dispatch and the tool result round-trip
 *     are all exercised rather than assumed
 */
import { generateText, stepCountIs } from 'ai'
import { MockLanguageModelV2 } from 'ai/test'
import { antibrowTools } from './index'

async function toolsRunForReal() {
  const browser = antibrowTools({ profile: 'ai-sdk-selfcheck', temporary: true })
  try {
    const opened = await browser.tools.browserGoto.execute!(
      { url: 'https://example.com' },
      { toolCallId: 'check-1', messages: [] },
    )
    console.log('goto ->', opened)
    const read = await browser.tools.browserRead.execute!(
      { selector: 'h1' },
      { toolCallId: 'check-2', messages: [] },
    )
    console.log('read ->', read)
  } finally {
    await browser.close()
  }
}

async function fullToolCallPath() {
  const browser = antibrowTools({ profile: 'ai-sdk-selfcheck', temporary: true })
  let step = 0
  const model = new MockLanguageModelV2({
    doGenerate: async () => {
      step += 1
      if (step === 1) {
        return {
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName: 'browserGoto',
              input: JSON.stringify({ url: 'https://example.com' }),
            },
          ],
          warnings: [],
        }
      }
      return {
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text' as const, text: 'opened it' }],
        warnings: [],
      }
    },
  })
  try {
    const result = await generateText({
      model,
      prompt: 'Open example.com.',
      tools: browser.tools,
      stopWhen: stepCountIs(3),
    })
    console.log('text ->', result.text)
    console.log('tool results ->', JSON.stringify(result.steps[0].toolResults, null, 1))
  } finally {
    await browser.close()
  }
}

async function main() {
  await toolsRunForReal()
  await fullToolCallPath()
  console.log('\nOK: tools ran live, and the AI SDK tool-call path completed.')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
