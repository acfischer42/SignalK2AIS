'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Reminders } = require('../lib/reminders')

function fixture() {
  const messages = []
  let task
  const reminders = new Reminders((path, value) => messages.push({ path, value }), 60000,
    (callback, delay) => { assert.equal(delay, 60000); task = callback; return 1 },
    () => { task = null })
  return { reminders, messages, tick: () => { const callback = task; task = null; callback?.() } }
}

test('baseline is silent; stable departure and arrival notify once with a webapp link', () => {
  const f = fixture()
  f.reminders.observe(5)
  f.tick()
  assert.equal(f.messages.length, 0)
  f.reminders.observe(0)
  f.reminders.observe(8)
  assert.equal(f.messages.length, 0)
  f.tick()
  assert.equal(f.messages.length, 1)
  assert.match(f.messages[0].value.message, /Departing/)
  assert.equal(f.messages[0].value.href, '/signalk-write-ais-nmea0183/')
  assert.deepEqual(f.messages[0].value.method, ['visual'])
  f.reminders.observe(0)
  f.tick()
  assert.equal(f.messages.length, 1)
  f.reminders.observe(1)
  f.tick()
  assert.match(f.messages[1].value.message, /Arrived/)
  f.reminders.clear()
  assert.equal(f.messages[2].value, null)
})

test('reverted, unsupported and stopped pending transitions never notify', () => {
  const f = fixture()
  f.reminders.observe(5)
  f.reminders.observe(0)
  f.reminders.observe(5)
  f.tick()
  f.reminders.observe(0)
  f.reminders.observe(null)
  f.tick()
  f.reminders.observe(0)
  f.reminders.stop()
  f.tick()
  assert.equal(f.messages.length, 0)
})

test('stop clears an active reminder and resets timers', () => {
  const f = fixture()
  f.reminders.observe(0)
  f.reminders.observe(5)
  f.tick()
  f.reminders.stop()
  assert.equal(f.messages.at(-1).value, null)
  assert.equal(f.reminders.active, null)
})
