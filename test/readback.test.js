'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Readback } = require('../lib/readback')
const { reports, sentence } = require('./helpers/ais')
const { nmeaSentence } = require('../lib/voyage')

const now = Date.parse('2026-10-31T17:00:00.000Z')
const submission = {
  submittedAt: new Date(now).toISOString(), destination: 'VIENNA',
  shipType: { id: 37 }, draft: 1.2, eta: '2026-11-15T12:00:00.000Z',
  navigationStatus: 5
}

function receiveVoyage(readback, report = reports(), start = now) {
  readback.receive(report.voyage[0], start)
  return readback.receive(report.voyage[1], start + 1)
}

test('reassembles message 5, preserves both raw sentences and decodes voyage fields', () => {
  const readback = new Readback()
  const input = reports()
  assert.equal(readback.receive(input.voyage[0], now).complete, false)
  assert.equal(readback.voyage, null)
  const result = readback.receive(Buffer.from(`${input.voyage[1]}\r\n`), now + 1)
  assert.equal(result.complete, true)
  assert.deepEqual(result.report.sentences, input.voyage)
  assert.equal(result.report.destination, 'VIENNA')
  assert.equal(result.report.mmsi, '211123456')
  assert.equal(result.report.shipType, 37)
  assert.equal(result.report.draft, 1.2)
  assert.deepEqual(result.report.eta, { month: 11, day: 15, hour: 12, minute: 0 })
})

test('supports navigation messages 1/2/3 and states 0/1/5/8/15', () => {
  for (const messageType of [1, 2, 3]) {
    for (const navigationStatus of [0, 1, 5, 8, 15]) {
      const readback = new Readback()
      readback.receive(reports({ messageType, navigationStatus }).navigation, now)
      assert.equal(readback.navigation.messageType, messageType)
      assert.equal(readback.navigation.navigationStatus, navigationStatus)
    }
  }
})

test('ignores other-vessel VDM, outgoing VSD, unsupported reports and global-shaped objects', () => {
  const readback = new Readback()
  const input = reports()
  assert.equal(readback.receive(input.navigation.replace('AIVDO', 'AIVDM'), now), null)
  assert.equal(readback.receive('$AIVSD,37,1.2,3,VIENNA,120000.00,15,11,5,0*48', now), null)
  assert.equal(readback.receive({ sentence: input.navigation }, now), null)
  assert.equal(readback.receive(reports({ messageType: 18 }).navigation, now), null)
  assert.equal(readback.lastRx, null)
})

test('checksum, armoring, length and padding failures are explicit and never decode', () => {
  const input = reports()
  for (const invalid of [
    input.navigation.slice(0, -2) + 'FF',
    sentence('AIVDO,1,1,,A,X,0'),
    sentence('AIVDO,1,1,,A,5,0'),
    sentence('AIVDO,1,1,,A,5,5'),
    '!AIVDO,1,1,,A,1,0*00\n!AIVDO,1,1,,A,1,0*00'
  ]) {
    const readback = new Readback()
    assert.throws(() => readback.receive(invalid, now))
    assert.equal(readback.voyage, null)
    assert.equal(readback.navigation, null)
    assert.equal(readback.lastError.sentence, invalid)
  }
})

test('rejects incomplete, inconsistent, duplicated and expired multipart reports', () => {
  const input = reports()
  const missing = new Readback()
  assert.throws(() => missing.receive(input.voyage[1], now), /without/)
  const duplicate = new Readback()
  duplicate.receive(input.voyage[0], now)
  assert.throws(() => duplicate.receive(input.voyage[0], now + 1), /Ambiguous/)
  const expired = new Readback()
  expired.receive(input.voyage[0], now)
  assert.throws(() => expired.receive(input.voyage[1], now + 30001), /without/)
  const wrongFill = new Readback()
  const body = input.voyage[0].slice(1, -4) + '1'
  assert.throws(() => wrongFill.receive(sentence(body), now), /fill bits/)
})

test('interleaved multipart IDs/channels are isolated and incomplete storage is bounded', () => {
  const readback = new Readback()
  const first = reports({ sequence: '1', channel: 'A', destination: 'VIENNA' })
  const second = reports({ sequence: '1', channel: 'B', destination: 'HAMBURG' })
  readback.receive(first.voyage[0], now)
  readback.receive(second.voyage[0], now)
  readback.receive(first.voyage[1], now + 1)
  assert.equal(readback.voyage.destination, 'VIENNA')
  readback.receive(second.voyage[1], now + 2)
  assert.equal(readback.voyage.destination, 'HAMBURG')
  for (let i = 0; i < 16; i++) {
    readback.receive(reports({ sequence: String(i % 10), channel: i < 10 ? 'A' : 'B' }).voyage[0], now)
  }
  assert.equal(readback.pending.size, 16)
  assert.throws(() => readback.receive(reports({ sequence: '6', channel: 'B' }).voyage[0], now), /Too many/)
})

test('distinguishes no submission, waiting, partial and complete matching readback', () => {
  const readback = new Readback()
  assert.equal(readback.comparison(null).status, 'no-submission')
  readback.markSubmission()
  assert.equal(readback.comparison(submission).status, 'waiting')
  receiveVoyage(readback)
  assert.equal(readback.comparison(submission).status, 'partial')
  readback.receive(reports().navigation, now + 2)
  const comparison = readback.comparison(submission)
  assert.equal(comparison.status, 'match')
  assert.equal(comparison.fields.length, 8)
  assert.ok(comparison.fields.every(field => field.status === 'match'))
})

test('pre-submission reports and fragments never confirm a new send, including same-millisecond reports', () => {
  const readback = new Readback()
  const input = reports()
  receiveVoyage(readback, input, now - 1)
  readback.receive(input.navigation, now)
  readback.markSubmission()
  assert.equal(readback.comparison(submission).status, 'waiting')
  assert.equal(readback.navigation.navigationStatus, 5)
  readback.receive(input.voyage[0], now + 1)
  readback.markSubmission()
  assert.throws(() => readback.receive(input.voyage[1], now + 2), /without/)
})

test('reports differing fields, unknown ETA and inconsistent MMSI as mismatch', () => {
  for (const changes of [{ destination: 'HAMBURG' }, { draft: 25 }, { shipType: 70 }, { hour: 24 }]) {
    const readback = new Readback()
    readback.markSubmission()
    receiveVoyage(readback, reports(changes))
    assert.equal(readback.comparison(submission).status, 'mismatch')
  }
  const readback = new Readback()
  readback.markSubmission()
  receiveVoyage(readback)
  readback.receive(reports({ mmsi: 211654321 }).navigation, now + 2)
  assert.equal(readback.comparison(submission).identityMatches, false)
  assert.equal(readback.comparison(submission).status, 'mismatch')
})

test('accepts empty sequence IDs and a fragment arriving exactly at the 30-second limit', () => {
  const readback = new Readback()
  const input = reports({ sequence: '', channel: '' })
  readback.receive(input.voyage[0], now)
  readback.receive(input.voyage[1], now + 30000)
  assert.equal(readback.voyage.destination, 'VIENNA')
  assert.equal(readback.pending.size, 0)
})

test('cleared destination and ETA match AIS not-available values, not midnight', () => {
  const readback = new Readback()
  readback.markSubmission()
  receiveVoyage(readback, reports({ destination: '', month: 0, day: 0, hour: 24, minute: 60 }))
  readback.receive(reports().navigation, now + 2)
  assert.equal(readback.comparison({ ...submission, destination: '', eta: null }).status, 'match')
  assert.equal(readback.comparison(submission).status, 'mismatch')
})

test('PIWWIVD requires fresh crew/passenger/other readback for a full Inland match', () => {
  const readback = new Readback()
  const inland = { ...submission, inlandPersonnel: { crew: 3, passengers: 0, other: 0 } }
  const raw = '$PIWWIVD,,,,,,,3,0,0,,,,*5D'
  readback.receive(raw, now)
  readback.markSubmission()
  receiveVoyage(readback)
  readback.receive(reports().navigation, now + 2)
  assert.equal(readback.comparison(inland).status, 'partial')
  assert.ok(readback.comparison(inland).fields.slice(-3).every(field => field.status === 'waiting'))
  readback.receive(raw, now + 3)
  assert.equal(readback.comparison(inland).status, 'match')
  assert.equal(readback.personnel.crew, 3)
  assert.equal(readback.lastRx.sentence, raw)
  assert.equal(readback.comparison(submission).fields.length, 8)
  assert.equal(readback.comparison(inland).fields.length, 11)
})

test('PIWWIVD decodes unknown sentinels and omitted fields without stale merging', () => {
  const readback = new Readback()
  const inland = { ...submission, inlandPersonnel: { crew: null, passengers: null, other: null } }
  readback.markSubmission()
  receiveVoyage(readback)
  readback.receive(reports().navigation, now + 2)
  readback.receive(nmeaSentence('PIWWIVD,,,,,,,255,8191,255,,,,'), now + 3)
  assert.equal(readback.comparison(inland).status, 'match')
  assert.equal(readback.personnel.crew, null)
  readback.receive(nmeaSentence('PIWWIVD,,,,,,,3,,,,,,'), now + 4)
  const fields = readback.comparison({ ...inland, inlandPersonnel: { crew: 3, passengers: 0, other: 0 } }).fields.slice(-3)
  assert.deepEqual(fields.map(field => field.status), ['match', 'waiting', 'waiting'])
  assert.equal(readback.personnel.passengers, undefined)
})

test('PIWWIVD rejects malformed, corrupt and out-of-range counts without replacing valid state', () => {
  const readback = new Readback()
  const raw = '$PIWWIVD,,,,,,,3,0,0,,,,*5D'
  readback.receive(raw, now)
  for (const invalid of [
    raw.slice(0, -2) + 'FF',
    nmeaSentence('PIWWIVD,3,0,0'),
    ...['256', '-1', '1.5', 'x'].map(crew => nmeaSentence(`PIWWIVD,,,,,,,${crew},0,0,,,,`)),
    nmeaSentence('PIWWIVD,,,,,,,0,8192,0,,,,'),
    nmeaSentence('PIWWIVD,,,,,,,0,0,256,,,,')
  ]) {
    assert.throws(() => readback.receive(invalid, now + 1))
    assert.equal(readback.personnel.crew, 3)
    assert.equal(readback.lastError.sentence, invalid)
  }
  assert.equal(readback.receive(nmeaSentence('PIWWIVD,,,,,,,,,,,,,'), now + 2), null)
})
