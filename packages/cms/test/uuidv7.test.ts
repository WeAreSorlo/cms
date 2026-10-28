import { uuidv7 } from '../src/db'
import { expect, test } from 'vitest'

test('makes version 7 UUIDs that start with the current time and sort by it', async () => {
  const first = uuidv7()
  await new Promise((resolve) => setTimeout(resolve, 2))
  const second = uuidv7()

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(Math.abs(parseInt(first.slice(0, 8) + first.slice(9, 13), 16) - Date.now())).toBeLessThan(1000)
  expect(first < second).toBe(true)
})
