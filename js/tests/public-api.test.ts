import { describe, it, expect } from 'vitest'
import * as sdk from '../src/index'

describe('public api', () => {
  it('exports the profile handle entry point', () => {
    expect(typeof sdk.profile).toBe('function')
    expect(typeof sdk.ProfileHandle).toBe('function')
  })
})
