'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { stateStatus, statusSentence, signalKDefaults } = require('../lib/navigation')

test('Auto-state values map to exact AIS statuses; null/unknown values never default to zero', () => {
  for (const [value, status] of [['motoring', 0], ['anchored', 1], ['moored', 5], ['sailing', 8]]) {
    assert.equal(stateStatus(value), status)
    const sentence = statusSentence(status)
    const body = sentence.slice(1, -3)
    assert.equal(body, `AIVSD,,,,,,,,${status},`)
    const checksum = [...body].reduce((sum, character) => sum ^ character.charCodeAt(0), 0)
    assert.equal(sentence.slice(-2), checksum.toString(16).toUpperCase().padStart(2, '0'))
  }
  for (const value of [null, undefined, '', 0, 'under way', 'constructor', {}]) {
    assert.equal(stateStatus(value), null)
  }
  assert.throws(() => statusSentence(15), /Unsupported/)
})

test('Signal K fallback accepts wrapped/unwrapped values, not non-string or invalid dates', () => {
  const values = {
    'navigation.destination.commonName': 'BRYC',
    'navigation.destination.eta': { value: '2026-11-06T09:00:00Z' }
  }
  const app = { getSelfPath: path => values[path] }
  assert.deepEqual(signalKDefaults(app), { destination: 'BRYC', eta: '2026-11-06T09:00:00.000Z' })
  values['navigation.destination.eta'] = null
  values['navigation.destination.commonName'] = 123
  assert.deepEqual(signalKDefaults(app), { destination: null, eta: null })
})
