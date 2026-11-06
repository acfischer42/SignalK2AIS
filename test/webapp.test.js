'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { buildVoyage } = require('../lib/voyage')
const { version, signalk } = require('../package.json')

const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8')
const script = readFileSync(join(__dirname, '../public/app.js'), 'utf8')

async function fixture(diagnostics = {}) {
  const listeners = new Map()
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', value: '', dataset: {}, options: [{}],
    addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback) },
    add(option) { this.options.push(option) },
    replaceChildren() {},
    reportValidity() { return true },
    append() {}
  }]))
  const data = {
    version, running: true, regionalFlags: 0,
    connection: { available: true, providerId: 'ais', event: 'ais-out' },
    vessel: { shipType: { id: 37, name: 'Pleasure' }, beam: 4.1, length: 21.6, draft: 1.2 },
    navigationStatuses: [{ id: 5, name: 'Moored' }, { id: 15, name: 'Not defined' }],
    diagnostics: {
      inputEvent: 'ais-voyage-in', comparison: { status: 'no-submission', fields: [] },
      ...diagnostics
    }
  }
  let failure
  let beforeValidation
  let sendFailure
  const posts = []
  const context = {
    URL, Intl,
    Date: class TestDate extends Date {
      constructor(...args) { super(...(args.length ? args : [Date.UTC(2026, 10, 4, 20, 5, 45)])) }
      static now() { return Date.UTC(2026, 10, 4, 20, 5, 45) }
    },
    Option: function (name, value) { this.name = name; this.value = value },
    document: {
      getElementById(id) {
        assert.ok(elements.has(id), `Missing HTML element: ${id}`)
        return elements.get(id)
      }
    },
    window: {
      location: { href: 'http://localhost:3000/signalk-write-ais-nmea0183/' },
      setInterval() {},
      addEventListener() {}
    },
    fetch: async (url, options) => {
      if (failure) throw failure
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        const path = url.pathname.split('/').pop()
        posts.push({ path, body })
        if (path === 'preview' && beforeValidation) await beforeValidation()
        if (path === 'voyage' && sendFailure) throw sendFailure
        const result = buildVoyage(body, data.vessel, data.regionalFlags)
        return {
          ok: true, headers: { get: () => 'application/json' },
          json: async () => path === 'preview' ? result : {
            ...result, submittedAt: '2026-11-04T20:06:00.000Z', message: 'Submitted to serial output.'
          }
        }
      }
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => data }
    }
  }
  runInNewContext(script, context)
  await new Promise(resolve => setImmediate(resolve))
  elements.get('personnel-mode').value = 'inland'
  return {
    data,
    posts,
    submit: () => listeners.get('voyage-form:submit')({ preventDefault() {} }),
    beforeValidation: callback => { beforeValidation = callback },
    failSend: () => { sendFailure = new Error('Connection lost') },
    disabled: () => elements.get('send-button').disabled,
    text: id => elements.get(id).textContent,
    value: id => elements.get(id).value,
    input: (id, value) => {
      elements.get(id).value = value
      listeners.get('voyage-form:input')({ target: { id } })
    },
    refresh: () => context.loadState(),
    fail: () => { failure = new Error('Server unreachable') }
  }
}

const voyage = {
  destination: 'VIENNA', shipType: 37, draft: 1.2,
  eta: { month: 11, day: 4, hour: 0, minute: 5 },
  mmsi: '205682570', receivedAt: '2026-11-04T07:00:00.000Z'
}

test('page is branded SignalK2AIS without the old eyebrow', async () => {
  assert.match(html, /<title>SignalK2AIS<\/title>/)
  assert.match(html, /<h1>SignalK2AIS<\/h1>/)
  assert.match(html, /Fields are prefilled from the latest AIS readback/)
  assert.doesNotMatch(html, /current-readback-heading/)
  assert.doesNotMatch(html, /SIGNAL K \/ OCEANSAT|AIS Voyage/)
  assert.match(html, /class="brand-mark" src="icon.svg"/)
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="icon.svg"/)
  assert.equal(signalk.appIcon, './icon.svg')
  assert.match(readFileSync(join(__dirname, '../public', signalk.appIcon), 'utf8'), /<svg xmlns=/)
  assert.equal(
    readFileSync(join(__dirname, '..', signalk.appIcon), 'utf8'),
    readFileSync(join(__dirname, '../public', signalk.appIcon), 'utf8')
  )
  assert.doesNotMatch(html, /preview-button|confirmation-heading|cancel-button/)
  for (const screenshot of signalk.screenshots) {
    const rootImage = readFileSync(join(__dirname, '..', screenshot))
    assert.deepEqual(rootImage, readFileSync(join(__dirname, '../public', screenshot)))
    assert.equal(rootImage.readUInt32BE(16), 1280)
    assert.equal(rootImage.readUInt32BE(20), 800)
    assert.ok(rootImage.length < 500000)
  }
})

test('first readback fills editable form values and converts AIS UTC ETA to local datetime', async () => {
  const f = await fixture({
    voyage: { ...voyage, eta: { month: 11, day: 5, hour: 12, minute: 30 } },
    navigation: { navigationStatus: 5 },
    personnel: { crew: 3, passengers: 0, other: 1 }
  })
  assert.equal(f.value('destination'), 'VIENNA')
  assert.equal(new Date(f.value('eta')).getTime(), Date.UTC(2026, 10, 5, 12, 30))
  assert.equal(f.value('navigation-status'), '5')
  assert.equal(f.value('crew'), '3')
  assert.equal(f.value('passengers'), '0')
  assert.equal(f.value('other-personnel'), '1')
})

test('past AIS month/day ETA uses its next occurrence, not an invented current-year date', async () => {
  const f = await fixture({ voyage: { ...voyage, eta: { month: 11, day: 4, hour: 19, minute: 0 } } })
  assert.equal(new Date(f.value('eta')).getTime(), Date.UTC(2027, 10, 4, 19, 0))
})

test('readback status 15 is prefilled so preview can submit unchanged values', async () => {
  const f = await fixture({ navigation: { navigationStatus: 15 } })
  assert.equal(f.value('navigation-status'), '15')
})

test('late readback fills untouched fields once and never overwrites user edits', async () => {
  const f = await fixture()
  f.input('destination', 'MY EDIT')
  f.input('eta', '')
  f.data.diagnostics = {
    ...f.data.diagnostics,
    voyage: { ...voyage, eta: { month: 11, day: 5, hour: 12, minute: 30 } },
    navigation: { navigationStatus: 5 },
    personnel: { crew: 3, passengers: 2, other: 1 }
  }
  await f.refresh()
  assert.equal(f.value('destination'), 'MY EDIT')
  assert.equal(f.value('eta'), '')
  assert.equal(f.value('navigation-status'), '5')
  assert.equal(f.value('crew'), '3')
  f.data.diagnostics.personnel = { crew: 4, passengers: 5, other: 6 }
  await f.refresh()
  assert.equal(f.value('crew'), '3')
  assert.equal(f.value('passengers'), '2')
  assert.equal(f.value('other-personnel'), '1')
})

test('API failure surfaces diagnostics warning without readback-specific section', async () => {
  const f = await fixture()
  f.fail()
  await f.refresh()
  assert.match(f.text('readback-status'), /Diagnostics unavailable/)
  assert.match(f.text('message'), /Server unreachable/)
})

test('Signal K fallback fills form only without voyage readback and managed state locks selector', async () => {
  const f = await fixture()
  f.data.signalKDefaults = { destination: 'BRYC', eta: '2026-11-06T08:00:00.000Z' }
  f.data.navigationState = { mode: 'on-send', source: 'signalk-autostate', current: { status: 5, value: 'moored' } }
  await f.refresh()
  assert.equal(f.value('destination'), 'BRYC')
  assert.equal(new Date(f.value('eta')).toISOString(), '2026-11-06T08:00:00.000Z')
  assert.equal(f.value('navigation-status'), '5')
  assert.match(f.text('navigation-state-hint'), /signalk-autostate/)
  f.data.navigationState.current = null
  await f.refresh()
  assert.equal(f.disabled(), true)
})

test('one form submission validates and sends the current readback without a confirmation step', async () => {
  const f = await fixture({
    voyage, navigation: { navigationStatus: 5 },
    personnel: { crew: 3, passengers: 0, other: 1 }
  })
  await f.submit()
  assert.deepEqual(f.posts.map(post => post.path), ['preview', 'voyage'])
  const body = f.posts[1].body
  assert.equal(body.destination, 'VIENNA')
  assert.equal(body.navigationStatus, 5)
  assert.deepEqual(body.inlandPersonnel, { crew: 3, passengers: 0, other: 1 })
  assert.equal(body.confirmedSentences.length, 2)
  assert.match(f.text('message'), /Submitted/)
  assert.equal(f.disabled(), false)
})

test('editing during validation aborts the send and repeated submits do not duplicate output', async () => {
  const f = await fixture({ navigation: { navigationStatus: 5 } })
  let release
  f.beforeValidation(() => new Promise(resolve => { release = resolve }))
  const pending = f.submit()
  assert.equal(f.disabled(), true)
  await f.submit()
  assert.equal(f.posts.length, 1)
  f.input('destination', 'CHANGED')
  release()
  await pending
  assert.deepEqual(f.posts.map(post => post.path), ['preview'])
  assert.match(f.text('message'), /Nothing was sent/)
  assert.equal(f.disabled(), false)
})

test('failed submission warns about uncertain delivery and is not retried automatically', async () => {
  const f = await fixture({ navigation: { navigationStatus: 5 } })
  f.failSend()
  await f.submit()
  assert.equal(f.posts.length, 2)
  assert.match(f.text('message'), /check the AIS display before retrying/)
  assert.equal(f.disabled(), false)
})
