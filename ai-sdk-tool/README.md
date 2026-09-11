# ai-sdk-tool-antibrow

AI SDK tools that drive a persistent [AntiBrow](https://antibrow.com) browser profile.

A browser tool that starts a fresh Chromium is fine for reading a public page and
useless for anything behind a login: the session dies with the process. These four
tools drive a profile instead, so the cookies, the storage, the fingerprint and the
exit IP are the same ones the agent used last time.

```bash
npm install ai-sdk-tool-antibrow
```

```ts
import { gateway, generateText, stepCountIs } from 'ai'
import { antibrowTools } from 'ai-sdk-tool-antibrow'

const browser = antibrowTools({ profile: 'research-01' })

try {
  const { text } = await generateText({
    model: gateway('openai/gpt-5-mini'),
    prompt: 'Open https://example.com and tell me the heading.',
    tools: browser.tools,
    stopWhen: stepCountIs(5),
  })
  console.log(text)
} finally {
  await browser.close()
}
```

Set `ANTI_DETECT_BROWSER_KEY`, or pass `key` to `antibrowTools()`. The engine
downloads on first launch and is cached. Unlimited local profiles and one
concurrent browser are free.

| Tool | Input | What it returns |
|---|---|---|
| `browserGoto` | `url` | HTTP status, page title, final URL |
| `browserRead` | `selector?` | visible text, truncated to `readLimit` (default 4000) |
| `browserClick` | `selector` | the selector clicked and the resulting URL |
| `browserFill` | `selector`, `text` | the selector filled and how many characters went in |

## Options

```ts
antibrowTools({
  profile: 'research-01',   // same name -> same fingerprint, cookies and storage
  proxy: 'http://user:pass@host:5001', // one exit IP per profile
  temporary: true,          // discard the profile on close
  headless: false,
  readLimit: 4000,
  key: process.env.ANTI_DETECT_BROWSER_KEY,
})
```

Two agents that must not share an identity need two profile names, not two tabs.
Close the session in a `finally`: a closed browser leaves nothing behind, an
abandoned one is a whole Chromium still running.

It does not promise that a given site will accept an automated session. A
persistent identity removes the tells that come from starting over every run - a
fresh profile, a stock automation fingerprint, your own IP - and that is all it
removes. Dated measurements, including the checks that fail, are published at
[antibrow.com/reports](https://antibrow.com/reports).

Full guide: [antibrow.com/docs/ai-sdk](https://antibrow.com/docs/ai-sdk) ·
SDK reference: [antibrow.com/docs/sdk](https://antibrow.com/docs/sdk) ·
MCP server: [antibrow.com/docs/mcp](https://antibrow.com/docs/mcp)

MIT.
