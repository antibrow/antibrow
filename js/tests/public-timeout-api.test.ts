import { describe, expect, it } from 'vitest'

import * as sdk from '../src/index'

// The CHANGELOG names these; a symbol only reachable through a deep path is not
// something a user can catch.
describe('the launch timeout is part of the public surface', () => {
  it('exports LaunchTimeoutError', () => {
    expect(typeof sdk.LaunchTimeoutError).toBe('function')
  })

  it('makes it catchable as an Error', () => {
    expect(new sdk.LaunchTimeoutError('x', 'step')).toBeInstanceOf(Error)
  })

  it('carries the step it ran out on', () => {
    expect(new sdk.LaunchTimeoutError('x', 'obtaining the license token').step).toBe(
      'obtaining the license token',
    )
  })
})
