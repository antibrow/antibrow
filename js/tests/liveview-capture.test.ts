import { describe, it, expect, vi } from 'vitest'
import { LiveViewStream } from '../src/liveview'

describe('LiveViewStream.startWithCapture', () => {
  it('subscribes to captureFrame and forwards frames to the socket', async () => {
    const sent: Buffer[] = []
    const stream = new LiveViewStream(
      {} as any, {} as any, 'ws://relay', 'sess', 'token', {},
    )
    ;(stream as any).sendFrame = (buf: Buffer) => sent.push(buf)
    ;(stream as any).connect = vi.fn(async () => undefined)

    let emit: (b: Buffer) => void = () => {}
    const captureFrame = vi.fn(async (onFrame: (b: Buffer) => void) => {
      emit = onFrame
      return () => undefined
    })

    await stream.startWithCapture(captureFrame as any, {})
    emit(Buffer.from('frame1'))
    expect(sent.map((b) => b.toString())).toContain('frame1')
  })
})
