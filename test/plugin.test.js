'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const createPlugin = require('../index')
const { version, signalk } = require('../package.json')
const { reports } = require('./helpers/ais')

function fixture() {
  const app = new EventEmitter()
  const errors = []
  const data = {
    'design.aisShipType': { value: { name: 'Pleasure', id: 37 } },
    'design.beam': { value: 4.1 },
    'design.draft': { value: { maximum: 1.2 } },
    'design.length': { value: { overall: 21.6 } }
  }
  app.getSelfPath = path => data[path]
  app.setPluginStatus = () => {}
  app.setPluginError = message => errors.push(message)
  app.error = message => errors.push(message)
  let stateCallback
  let stateSubscribed = false
  app.selfId = 'urn:mrn:imo:mmsi:205682570'
  app.subscriptionmanager = {
    subscribe(subscription, unsubscribes, error, callback) {
      assert.equal(subscription.context, 'vessels.self')
      stateCallback = callback
      stateSubscribed = true
      unsubscribes.push(() => { stateSubscribed = false })
    }
  }
  let subscribed = false
  let publish
  app.onPropertyValues = (name, callback) => {
    assert.equal(name, 'serialport')
    subscribed = true
    publish = callback
    callback([undefined, { value: { id: 'ais', eventNames: { toStdout: 'serial-ais-toStdout' } } }])
    return () => { subscribed = false }
  }
  const routes = new Map()
  const plugin = createPlugin(app)
  plugin.registerWithRouter({
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler)
  })
  function request(method, path, body, headers = {}) {
    const result = { status: 200, headers: {} }
    const req = { body, get: name => ({ Host: 'localhost:3000', ...headers })[name] }
    const res = {
      status(code) { result.status = code; return res },
      set(name, value) { result.headers[name] = value; return res },
      json(value) { result.body = value; return res }
    }
    routes.get(`${method} ${path}`)(req, res)
    return result
  }
  return {
    app, plugin, request, data, errors, isSubscribed: () => subscribed, publish: history => publish(history),
    stateSubscribed: () => stateSubscribed,
    stateDelta: (value, source = 'signalk-autostate', context = 'vessels.self') => stateCallback({
      context, updates: [{ source: { label: source }, values: [{ path: 'navigation.state', value }] }]
    })
  }
}

const input = {
  destination: 'VIENNA', eta: '2026-11-15T12:00:00.000Z',
  navigationStatus: 5, personsOnBoard: 3
}

test('reminders work in manual mode, ignore AIS, clear through protected API and never send commands', async () => {
  const f = fixture()
  const published = []
  f.app.handleMessage = (id, delta) => published.push({ id, delta })
  f.app.on('serial-ais-toStdout', () => assert.fail('Reminder must not write AIS'))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0, enableVoyageReminders: true, reminderDelaySeconds: 1 })
  try {
    assert.equal(f.stateSubscribed(), true)
    f.stateDelta('moored')
    f.stateDelta('motoring', 'ais')
    assert.equal(published.length, 0)
    f.stateDelta('motoring')
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(published.length, 1)
    assert.equal(published[0].delta.updates[0].values[0].path, 'notifications.aisVoyage.checklist')
    assert.match(f.request('GET', '/state').body.reminder.message, /Departing/)
    assert.equal(f.request('POST', '/reminders/clear', {}, { Origin: 'http://other' }).status, 403)
    assert.equal(f.request('POST', '/reminders/clear', {}).status, 200)
    assert.equal(published.at(-1).delta.updates[0].values[0].value, null)
    assert.equal(f.request('GET', '/state').body.reminder, null)
  } finally {
    f.plugin.stop()
  }
  assert.equal(f.stateSubscribed(), false)
})

test('reminders are opt-in and configuration validates checkbox and delay', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  assert.equal(f.stateSubscribed(), false)
  assert.equal(f.plugin.schema().properties.enableVoyageReminders.default, false)
  assert.throws(() => f.plugin.start({ providerId: 'ais', regionalFlags: 0, enableVoyageReminders: 'true' }), /boolean/)
  assert.throws(() => f.plugin.start({ providerId: 'ais', regionalFlags: 0, reminderDelaySeconds: 0 }), /Reminder delay/)
})

test('navigation.state on-send uses autostate and ignores AIS and other vessels', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0, navigationStateMode: 'on-send' })
  assert.equal(f.request('POST', '/preview', input).status, 422)
  f.stateDelta('sailing', 'ais')
  f.stateDelta('sailing', 'signalk-autostate', 'vessels.other')
  assert.equal(f.request('POST', '/preview', input).status, 422)
  f.stateDelta('motoring')
  const preview = f.request('POST', '/preview', input)
  assert.equal(preview.body.navigationStatus, 0)
  f.stateDelta('anchored')
  f.app.on('serial-ais-toStdout', () => assert.fail('stale status must not send'))
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.body.sentence }).status, 409)
  f.plugin.stop()
  assert.equal(f.stateSubscribed(), false)
})

test('automatic state sends status only, deduplicates and never publishes commanded values to Signal K', () => {
  const f = fixture()
  const sent = []
  f.app.handleMessage = () => assert.fail('Must not publish requested values')
  f.app.on('serial-ais-toStdout', sentence => sent.push(sentence))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0, navigationStateMode: 'automatic' })
  f.stateDelta('moored', 'ais')
  f.stateDelta('moored')
  f.stateDelta('moored')
  f.stateDelta('motoring')
  assert.equal(sent.length, 2)
  for (const [index, sentence] of sent.entries()) {
    const fields = sentence.slice(1, -3).split(',')
    assert.equal(fields.length, 10)
    assert.equal(fields[8], index === 0 ? '5' : '0')
    assert.ok(fields.slice(1, 8).every(field => field === ''))
    assert.equal(fields[9], '')
  }
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
  assert.equal(f.request('GET', '/state').body.navigationState.lastSubmission.status, 0)
  f.stateDelta('unsupported')
  assert.equal(f.request('GET', '/state').body.navigationState.current, null)
  assert.ok(f.errors.some(message => message.includes('Unsupported navigation.state')))
})

test('automatic send failures are explicit and not retried on repeated reports', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0, navigationStateMode: 'automatic' })
  f.stateDelta('moored')
  const count = f.errors.length
  assert.ok(count > 0)
  f.stateDelta('moored')
  assert.equal(f.errors.length, count)
  assert.equal(f.request('GET', '/state').body.navigationState.lastSubmission, null)
})

test('Signal K destination and ETA are exposed for form fallback without publishing anything', () => {
  const f = fixture()
  f.data['navigation.destination.commonName'] = { value: 'BRYC' }
  f.data['navigation.destination.eta'] = { value: '2026-11-06T08:30:00Z' }
  assert.deepEqual(f.request('GET', '/state').body.signalKDefaults, {
    destination: 'BRYC', eta: '2026-11-06T08:30:00.000Z'
  })
})

test('exposes package version in server state and plugin configuration descriptions', () => {
  const f = fixture()
  assert.equal(f.plugin.name, 'SignalK2AIS')
  assert.equal(signalk.displayName, 'SignalK2AIS')
  assert.equal(f.request('GET', '/state').body.version, version)
  assert.ok(f.plugin.description.includes(`v${version}`))
  assert.equal(f.plugin.schema().description, `Installed plugin version: ${version}`)
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  assert.equal(f.request('GET', '/state').body.version, version)
})

test('labels the existing provider setting Data Connection ID without changing its key', () => {
  const schema = fixture().plugin.schema()
  assert.equal(schema.properties.providerId.title, 'Data Connection ID')
  assert.ok(schema.required.includes('providerId'))
})

test('routes explicitly reject writes while disabled', () => {
  const f = fixture()
  assert.equal(f.request('GET', '/state').body.running, false)
  assert.equal(f.request('POST', '/preview', input).status, 503)
  assert.equal(f.request('POST', '/voyage', input).status, 503)
  assert.ok(f.errors.length > 0)
})

test('reuses only selected serial event, never global NMEA output, and returns unconfirmed 202', () => {
  const f = fixture()
  const sent = []
  f.app.on('serial-ais-toStdout', sentence => sent.push(sentence))
  f.app.on('nmea0183out', () => assert.fail('Must not broadcast on global output'))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const preview = f.request('POST', '/preview', input)
  assert.equal(preview.status, 200)
  assert.equal(sent.length, 0)
  const result = f.request('POST', '/voyage', { ...input, confirmedSentence: preview.body.sentence })
  assert.equal(result.status, 202)
  assert.deepEqual(sent, [preview.body.sentence])
  assert.match(result.body.message, /Not an AIS acknowledgement/)
  assert.equal(f.request('GET', '/state').body.lastSubmission.destination, 'VIENNA')
  f.plugin.stop()
  assert.equal(f.isSubscribed(), false)
  assert.equal(f.request('GET', '/state').body.connection.available, false)
})

test('missing output listener fails without reporting a submission', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const preview = f.request('POST', '/preview', input).body
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence }).status, 503)
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
})

test('unknown provider ID does not fall back to another serial port', () => {
  const f = fixture()
  f.app.on('serial-ais-toStdout', () => assert.fail('Wrong output'))
  f.plugin.start({ providerId: 'other', regionalFlags: 0 })
  const state = f.request('GET', '/state').body
  assert.equal(state.connection.available, false)
  assert.deepEqual(state.connection.knownSerialConnections, ['ais'])
})

test('reactively discovers connections added after plugin startup', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'late', regionalFlags: 0 })
  assert.equal(f.request('GET', '/state').body.connection.available, false)
  f.app.on('serial-late-toStdout', () => {})
  f.publish([undefined, { value: { id: 'late', eventNames: { toStdout: 'serial-late-toStdout' } } }])
  assert.equal(f.request('GET', '/state').body.connection.available, true)
})

test('requires exact preview and re-reads Signal K source data at send time', () => {
  const f = fixture()
  f.app.on('serial-ais-toStdout', () => assert.fail('Stale data must not send'))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  assert.equal(f.request('POST', '/voyage', input).status, 409)
  const preview = f.request('POST', '/preview', input).body
  f.data['design.draft'].value.maximum = 1.5
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence }).status, 409)
})

test('rejects cross-site requests and logs validation errors', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  for (const headers of [
    { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }
  ]) {
    assert.equal(f.request('POST', '/preview', input, headers).status, 403)
  }
  assert.equal(f.request('POST', '/preview', { ...input, destination: 'A'.repeat(21) }).status, 400)
  assert.equal(f.request('POST', '/preview', input, { Origin: 'http://localhost:3000' }).status, 200)
  assert.ok(f.errors.length >= 4)
})

test('invalid startup configuration fails loudly and releases subscriptions', () => {
  for (const options of [undefined, { providerId: 'ais' }, { providerId: '../ais', regionalFlags: 0 }]) {
    const f = fixture()
    assert.throws(() => f.plugin.start(options))
    assert.equal(f.isSubscribed(), false)
    assert.equal(f.request('GET', '/state').body.running, false)
    assert.ok(f.errors.length > 0)
  }
})

test('unexpected serial errors return explicit failure, not optimistic success', () => {
  const f = fixture()
  f.app.on('serial-ais-toStdout', () => { throw new Error('Serial failed') })
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const preview = f.request('POST', '/preview', input).body
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence }).status, 503)
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
  assert.ok(f.errors.some(error => error.includes('Serial failed')))
})

test('supports plugin API wrappers without listenerCount and fails if emit has no listener', () => {
  const f = fixture()
  f.app.listenerCount = undefined
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  assert.equal(f.request('GET', '/state').status, 200)
  const preview = f.request('POST', '/preview', input).body
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence }).status, 503)
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
})

test('supports explicit output routing on older servers without serial advertisements', () => {
  const f = fixture()
  f.app.listenerCount = undefined
  f.app.onPropertyValues = (name, callback) => { callback([undefined]); return () => {} }
  const sent = []
  f.app.on('ais-voyage-out', sentence => sent.push(sentence))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0, outputEvent: 'ais-voyage-out' })
  const state = f.request('GET', '/state').body
  assert.equal(state.connection.explicitEvent, true)
  assert.equal(state.connection.event, 'ais-voyage-out')
  const preview = f.request('POST', '/preview', input).body
  assert.equal(f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence }).status, 202)
  assert.deepEqual(sent, [preview.sentence])
})

test('refuses arbitrary explicit event names such as global broadcast or error events', () => {
  for (const outputEvent of ['nmea0183out', 'error', 'ais-voyage-out\n', 0]) {
    const f = fixture()
    assert.throws(() => f.plugin.start({ providerId: 'ais', regionalFlags: 0, outputEvent }))
  }
})

test('listens only on the dedicated AIS input event, exposes full raw readback and cleans up on stop', () => {
  const f = fixture()
  f.app.on('serial-ais-toStdout', () => {})
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const preview = f.request('POST', '/preview', input).body
  f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence })
  const incoming = reports()
  f.app.emit('nmea0183', incoming.navigation)
  assert.equal(f.request('GET', '/state').body.diagnostics.navigation, null)
  for (const sentence of [...incoming.voyage, incoming.navigation]) f.app.emit('ais-voyage-in', sentence)
  const state = f.request('GET', '/state').body
  assert.equal(state.diagnostics.comparison.status, 'match')
  assert.deepEqual(state.diagnostics.voyage.sentences, incoming.voyage)
  assert.equal(state.diagnostics.lastRx.sentence, incoming.navigation)
  assert.equal(state.diagnostics.inputEvent, 'ais-voyage-in')
  assert.equal(f.app.listenerCount('ais-voyage-in'), 1)
  f.plugin.stop()
  assert.equal(f.app.listenerCount('ais-voyage-in'), 0)
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  assert.equal(f.app.listenerCount('ais-voyage-in'), 1)
})

test('malformed receive input is logged, exposed, and does not interrupt serial input', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  f.app.emit('ais-voyage-in', '!AIVDO,bad')
  assert.match(f.request('GET', '/state').body.diagnostics.lastError.message, /format/)
  assert.ok(f.errors.some(error => error.includes('AIS readback:')))
  f.app.emit('ais-voyage-in', reports().navigation)
  assert.equal(f.request('GET', '/state').body.diagnostics.lastError, null)
})

test('configuration rejects global or colliding RX events', () => {
  for (const inputEvent of ['nmea0183', 'ais-voyage-out', 'ais-voyage-bad\n', 'ais-voyage-out-toStdout']) {
    const f = fixture()
    assert.throws(() => f.plugin.start({ providerId: 'ais', regionalFlags: 0, outputEvent: 'ais-voyage-out', inputEvent }))
    assert.equal(f.app.listenerCount(inputEvent), 0)
  }
})

test('server logging includes full submitted sentence and every related raw receive fragment', t => {
  const log = t.mock.method(console, 'log', () => {})
  const f = fixture()
  f.app.on('serial-ais-toStdout', () => {})
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const preview = f.request('POST', '/preview', input).body
  f.request('POST', '/voyage', { ...input, confirmedSentence: preview.sentence })
  const incoming = reports()
  for (const raw of [...incoming.voyage, incoming.navigation]) f.app.emit('ais-voyage-in', raw)
  const logs = log.mock.calls.map(call => call.arguments[0])
  assert.ok(logs.some(line => line.includes('TX submitted') && line.endsWith(preview.sentence)))
  for (const raw of [...incoming.voyage, incoming.navigation]) {
    assert.ok(logs.some(line => /RX \d{4}-\d{2}-\d{2}T/.test(line) && line.endsWith(raw)))
  }
})

test('Inland sends both confirmed sentences in order, rejects stale count previews', () => {
  const f = fixture()
  const sent = []
  f.app.on('serial-ais-toStdout', sentence => sent.push(sentence))
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const { personsOnBoard, ...voyage } = input
  const body = { ...voyage, inlandPersonnel: { crew: 3, passengers: 0, other: 0 } }
  const preview = f.request('POST', '/preview', body).body
  assert.equal(f.request('POST', '/voyage', { ...body, confirmedSentence: preview.sentence }).status, 409)
  const changed = { ...body, inlandPersonnel: { crew: 2, passengers: 1, other: 0 } }
  assert.equal(f.request('POST', '/voyage', { ...changed, confirmedSentences: preview.sentences }).status, 409)
  assert.equal(sent.length, 0)
  const result = f.request('POST', '/voyage', { ...body, confirmedSentences: preview.sentences })
  assert.equal(result.status, 202)
  assert.deepEqual(sent, preview.sentences)
  assert.deepEqual(f.request('GET', '/state').body.lastSubmission.inlandPersonnel, body.inlandPersonnel)
})

test('partial Inland output failure reports exactly how many commands were submitted', () => {
  const f = fixture()
  f.app.on('serial-ais-toStdout', sentence => {
    if (sentence.startsWith('$PIWWIVD')) throw new Error('Second write failed')
  })

  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const { personsOnBoard, ...voyage } = input
  const body = { ...voyage, inlandPersonnel: { crew: 3, passengers: 0, other: 0 } }
  const preview = f.request('POST', '/preview', body).body
  const result = f.request('POST', '/voyage', { ...body, confirmedSentences: preview.sentences })
  assert.equal(result.status, 503)
  assert.match(result.body.error, /after 1\/2 sentences/)
  assert.equal(f.request('GET', '/state').body.lastSubmission, null)
})

test('PIWWIVD input appears in diagnostics only through the dedicated receive event', () => {
  const f = fixture()
  f.plugin.start({ providerId: 'ais', regionalFlags: 0 })
  const raw = '$PIWWIVD,,,,,,,3,0,0,,,,*5D'
  f.app.emit('nmea0183', raw)
  f.app.emit('serial-ais-toStdout', raw)
  assert.equal(f.request('GET', '/state').body.diagnostics.personnel, null)
  f.app.emit('ais-voyage-in', raw)
  const diagnostics = f.request('GET', '/state').body.diagnostics
  assert.equal(diagnostics.personnel.crew, 3)
  assert.equal(diagnostics.personnel.passengers, 0)
  assert.equal(diagnostics.lastRx.sentence, raw)
  f.plugin.stop()
  assert.equal(f.request('GET', '/state').body.diagnostics.personnel, null)
})
