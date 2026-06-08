import { describe, it, expect } from 'vitest'
import { createState, consumeState } from '../src/oauth-state.js'

describe('oauth-state', () => {
  it('accepts a freshly created state exactly once', () => {
    createState('abc')
    expect(consumeState('abc')).toBe(true)
    expect(consumeState('abc')).toBe(false) // single-use
  })

  it('rejects an unknown state', () => {
    expect(consumeState('never-created')).toBe(false)
  })
})
