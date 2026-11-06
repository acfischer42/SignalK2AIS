'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { vesselDetails, buildVoyage } = require('../lib/voyage')

const vessel = { shipType: { id: 37, name: 'Pleasure' }, beam: 4.1, draft: 1.2, length: 21.6 }
const input = {
  destination: 'VIENNA', eta: '2026-11-15T12:00:00.000Z',
  navigationStatus: 5, personsOnBoard: 3
}

test('reads requested Signal K value shapes, including wrappers', () => {
  const values = {
    'design.aisShipType': { value: { name: 'Pleasure', id: 37 } },
    'design.beam': { value: 4.1 },
    'design.draft': { value: { maximum: 1.2 } },
    'design.length': { value: { overall: 21.6 } }
  }
  assert.deepEqual(vesselDetails({ getSelfPath: path => values[path] }), vessel)
  assert.deepEqual(vesselDetails({ getSelfPath: path => values[path]?.value }), vessel)
})

test('missing vessel data is unavailable, not the example defaults', () => {
  assert.deepEqual(vesselDetails({ getSelfPath: () => undefined }), {
    shipType: { id: null, name: null }, beam: null, draft: null, length: null
  })
})

test('encodes exactly nine voyage fields with independent checksum verification', () => {
  const result = buildVoyage(input, vessel, 0)
  const body = 'AIVSD,37,1.2,3,VIENNA,120000.00,15,11,5,0'
  assert.equal(result.sentence.slice(1, -3), body)
  const expected = Buffer.from(body).reduce((checksum, byte) => checksum ^ byte, 0)
  assert.equal(result.sentence.slice(-2), expected.toString(16).toUpperCase().padStart(2, '0'))
  assert.equal(result.sentence.includes('\r'), false)
  assert.equal(body.split(',').length, 10)
  assert.equal(result.sentence.includes('21.6'), false)
  assert.equal(result.sentence.includes('4.1'), false)
})

test('matches previously verified VIENNA examples', () => {
  for (const [navigationStatus, checksum] of [[0, '49'], [1, '48'], [5, '4C'], [8, '41']]) {
    assert.equal(
      buildVoyage({ ...input, navigationStatus }, { ...vessel, draft: 2.5 }, 0).sentence,
      `$AIVSD,37,2.5,3,VIENNA,120000.00,15,11,${navigationStatus},0*${checksum}`
    )
  }
})

test('normalizes destination and preserves exactly 20 characters', () => {
  assert.equal(buildVoyage({ ...input, destination: ' vienna ' }, vessel, 0).destination, 'VIENNA')
  assert.equal(buildVoyage({ ...input, destination: 'A'.repeat(20) }, vessel, 0).destination.length, 20)
})

test('rejects oversized, Unicode and sentence-injection destinations', () => {
  for (const destination of ['A'.repeat(21), 'WIEN,0', 'WIEN*00', '$AIVSD', 'WI\r\nEN', 'MÜNCHEN']) {
    assert.throws(() => buildVoyage({ ...input, destination }, vessel, 0), /Destination/)
  }
})

test('validates calendar dates, UTC format and month/day order', () => {
  for (const eta of ['2026-02-30T12:00:00.000Z', '2026-11-15', '2026-11-15T12:00:00+01:00', 'invalid']) {
    assert.throws(() => buildVoyage({ ...input, eta }, vessel, 0), /ETA/)
  }
  assert.match(buildVoyage({ ...input, eta: '2028-02-29T23:59:00.000Z' }, vessel, 0).sentence,
    /,235900\.00,29,02,5,0\*/)
})

test('rejects unsupported states and invalid persons, including numeric strings', () => {
  for (const navigationStatus of [-1, 9, 14, 16, 1.5, '5', null]) {
    assert.throws(() => buildVoyage({ ...input, navigationStatus }, vessel, 0), /status/)
  }
  for (const personsOnBoard of [-1, 8192, 1.5, '3', undefined]) {
    assert.throws(() => buildVoyage({ ...input, personsOnBoard }, vessel, 0), /Persons/)
  }
  for (const personsOnBoard of [0, 8191]) {
    assert.equal(buildVoyage({ ...input, personsOnBoard }, vessel, 0).personsOnBoard, personsOnBoard)
  }
})

test('rejects invalid source data rather than clamping or guessing', () => {
  for (const id of [null, undefined, '37', -1, 256, 37.5]) {
    assert.throws(() => buildVoyage(input, { ...vessel, shipType: { id } }, 0),
      error => error.status === 422)
  }
  for (const draft of [null, undefined, '1.2', -0.1, 25.6, NaN, Infinity]) {
    assert.throws(() => buildVoyage(input, { ...vessel, draft }, 0),
      error => error.status === 422)
  }
  assert.equal(buildVoyage(input, { ...vessel, draft: 1.26 }, 0).draft, 1.3)
  assert.equal(buildVoyage(input, { ...vessel, draft: 25.5 }, 0).draft, 25.5)
})

test('validates regional flags and refuses client-supplied vessel overrides', () => {
  for (const flags of [-1, 16, '0', undefined]) {
    assert.throws(() => buildVoyage(input, vessel, flags), /Regional/)
  }
  assert.throws(() => buildVoyage({ ...input, shipType: 99 }, vessel, 0), /Unexpected/)
  for (const invalid of [null, [], 'VIENNA']) assert.throws(() => buildVoyage(invalid, vessel, 0), /JSON/)
})

test('Inland personnel use precisely PIWWIVD fields 7–9 and leave all other fields null', () => {
  const { personsOnBoard, ...voyage } = input
  const result = buildVoyage({ ...voyage, inlandPersonnel: { crew: 3, passengers: 0, other: 0 } }, vessel, 0)
  assert.equal(result.personsOnBoard, 3)
  assert.equal(result.sentences[0], result.sentence)
  assert.equal(result.sentences[1], '$PIWWIVD,,,,,,,3,0,0,,,,*5D')
  const fields = result.sentences[1].slice(1, -3).split(',')
  assert.equal(fields.length, 14)
  assert.deepEqual(fields.slice(7, 10), ['3', '0', '0'])
  for (const index of [1, 2, 3, 4, 5, 6, 10, 11, 12, 13]) assert.equal(fields[index], '')
  assert.equal(buildVoyage(input, vessel, 0).sentences.length, 1)
})

test('Inland personnel counts are explicit, bounded and cannot conflict with a total', () => {
  const { personsOnBoard, ...voyage } = input
  for (const inlandPersonnel of [
    null, [], {}, { crew: 255, passengers: 0, other: 0 },
    { crew: 0, passengers: 8191, other: 0 }, { crew: 0, passengers: 0, other: 255 },
    { crew: '3', passengers: 0, other: 0 }, { crew: 3, passengers: -1, other: 0 },
    { crew: 3.5, passengers: 0, other: 0 }, { crew: 3, passengers: 0, other: 0, extra: 1 }
  ]) assert.throws(() => buildVoyage({ ...voyage, inlandPersonnel }, vessel, 0))
  const inlandPersonnel = { crew: 254, passengers: 8190, other: 254 }
  assert.equal(buildVoyage({ ...voyage, inlandPersonnel }, vessel, 0).personsOnBoard, 8191)
  assert.throws(() => buildVoyage({ ...input, inlandPersonnel }, vessel, 0), /separate persons total/)
})

test('blank destination and ETA explicitly encode not available rather than unchanged', () => {
  for (const destination of ['', '   ']) {
    const result = buildVoyage({ ...input, destination, eta: null, personsOnBoard: null }, vessel, 0)
    assert.equal(result.destination, '')
    assert.equal(result.eta, null)
    assert.equal(result.personsOnBoard, 0)
    assert.equal(result.sentence.slice(1, -3),
      'AIVSD,37,1.2,0,@@@@@@@@@@@@@@@@@@@@,246000.00,00,00,5,0')
  }
  assert.throws(() => buildVoyage({ ...input, destination: '', eta: null, navigationStatus: null }, vessel, 0), /status/)
})

test('blank Inland counts use unknown sentinels, preserving explicit zero counts', () => {
  const { personsOnBoard, ...voyage } = input
  for (const inlandPersonnel of [
    { crew: null, passengers: null, other: null },
    { crew: 3, passengers: null, other: 0 }
  ]) {
    const result = buildVoyage({ ...voyage, inlandPersonnel }, vessel, 0)
    const fields = result.sentences[1].slice(1, -3).split(',')
    assert.deepEqual(fields.slice(7, 10), [
      String(inlandPersonnel.crew ?? 255), String(inlandPersonnel.passengers ?? 8191),
      String(inlandPersonnel.other ?? 255)
    ])
    assert.equal(result.personsOnBoard, 8191)
  }
})
