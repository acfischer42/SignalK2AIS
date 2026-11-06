'use strict'

const NAV_STATUSES = [
  [0, 'Under way using engine'],
  [1, 'At anchor'],
  [2, 'Not under command'],
  [3, 'Restricted manoeuvrability'],
  [4, 'Constrained by her draught'],
  [5, 'Moored'],
  [6, 'Aground'],
  [7, 'Engaged in fishing'],
  [8, 'Under way sailing'],
  [15, 'Not defined']
].map(([id, name]) => ({ id, name }))

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RequestError(`${label} must be an integer from ${min} to ${max}.`)
  }
  return value
}

function readValue(app, path) {
  const entry = app.getSelfPath(path)
  return entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')
    ? entry.value
    : entry
}

function vesselDetails(app) {
  const type = readValue(app, 'design.aisShipType')
  const draft = readValue(app, 'design.draft')
  const length = readValue(app, 'design.length')
  const beam = readValue(app, 'design.beam')
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null
  return {
    shipType: {
      id: Number.isInteger(type?.id) ? type.id : null,
      name: typeof type?.name === 'string' ? type.name : null
    },
    draft: finite(draft?.maximum),
    beam: finite(beam),
    length: finite(length?.overall)
  }
}

function nmeaSentence(body) {
  let checksum = 0
  for (const character of body) checksum ^= character.charCodeAt(0)
  return `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`
}

function buildVoyage(input, vessel, regionalFlags) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestError('Provide a JSON voyage object.')
  }
  const allowed = ['destination', 'eta', 'navigationStatus', 'personsOnBoard', 'inlandPersonnel', 'confirmedSentence', 'confirmedSentences']
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new RequestError('Unexpected voyage field. Vessel details are read from Signal K only.')
  }
  if (typeof input.destination !== 'string') {
    throw new RequestError('Destination is required.')
  }
  const destination = input.destination.trim().toUpperCase()
  if (!/^[A-Z0-9 ./'()+-]{0,20}$/.test(destination)) {
    throw new RequestError("Destination must be 1–20 characters: A–Z, digits, spaces, or . / ' ( ) + -.")
  }
  const noEta = input.eta === null || input.eta === ''
  if (!noEta && (typeof input.eta !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.eta))) {
    throw new RequestError('ETA must be an ISO date/time in UTC.')
  }
  const eta = noEta ? null : new Date(input.eta)
  if (eta && (!Number.isFinite(eta.getTime()) || eta.toISOString() !== input.eta)) {
    throw new RequestError('ETA is not a valid calendar date/time.')
  }
  const navigationStatus = integer(input.navigationStatus, 0, 15, 'Navigational status')
  if (!NAV_STATUSES.some(status => status.id === navigationStatus)) {
    throw new RequestError('Choose a navigational status supported by the Oceansat menu.')
  }
  let inlandPersonnel
  let personsOnBoard
  if (input.inlandPersonnel !== undefined) {
    const personnel = input.inlandPersonnel
    if (!personnel || typeof personnel !== 'object' || Array.isArray(personnel) ||
        Object.keys(personnel).some(key => !['crew', 'passengers', 'other'].includes(key))) {
      throw new RequestError('Inland personnel must contain crew, passengers and other counts only.')
    }
    if (input.personsOnBoard !== undefined) {
      throw new RequestError('Do not supply a separate persons total with Inland personnel.')
    }
    inlandPersonnel = {
      crew: personnel.crew === null ? null : integer(personnel.crew, 0, 254, 'Crew'),
      passengers: personnel.passengers === null ? null : integer(personnel.passengers, 0, 8190, 'Passengers'),
      other: personnel.other === null ? null : integer(personnel.other, 0, 254, 'Other personnel')
    }
    const total = inlandPersonnel.crew + inlandPersonnel.passengers + inlandPersonnel.other
    // The standard VSD total cannot represent 8191 or more as a known count.
    personsOnBoard = Object.values(inlandPersonnel).includes(null) || total > 8190 ? 8191 : total
  } else {
    personsOnBoard = input.personsOnBoard === null ? 0 : integer(input.personsOnBoard, 0, 8191, 'Persons on board')
  }
  if (!Number.isInteger(vessel.shipType.id) || vessel.shipType.id < 0 || vessel.shipType.id > 255) {
    throw new RequestError('Signal K design.aisShipType.id is missing or invalid.', 422)
  }
  if (typeof vessel.draft !== 'number' || !Number.isFinite(vessel.draft) ||
      vessel.draft < 0 || vessel.draft > 25.5) {
    throw new RequestError('Signal K design.draft.maximum must be 0–25.5 metres.', 422)
  }
  integer(regionalFlags, 0, 15, 'Regional application flags')
  const pad = value => String(value).padStart(2, '0')
  const time = eta ? `${pad(eta.getUTCHours())}${pad(eta.getUTCMinutes())}${pad(eta.getUTCSeconds())}.00` : '246000.00'
  const draft = vessel.draft.toFixed(1)
  const sentence = nmeaSentence([
    'AIVSD', vessel.shipType.id, draft, personsOnBoard, destination || '@'.repeat(20), time,
    eta ? pad(eta.getUTCDate()) : '00', eta ? pad(eta.getUTCMonth() + 1) : '00', navigationStatus, regionalFlags
  ].join(','))
  const sentences = [sentence]
  if (inlandPersonnel) {
    const fields = Array(13).fill('')
    fields[6] = inlandPersonnel.crew ?? 255
    fields[7] = inlandPersonnel.passengers ?? 8191
    fields[8] = inlandPersonnel.other ?? 255
    sentences.push(nmeaSentence(['PIWWIVD', ...fields].join(',')))
  }
  return {
    destination, eta: eta ? eta.toISOString() : null, navigationStatus, personsOnBoard,
    ...(inlandPersonnel ? { inlandPersonnel } : {}),
    shipType: vessel.shipType, draft: Number(draft), regionalFlags, sentence, sentences
  }
}

module.exports = { NAV_STATUSES, RequestError, integer, vesselDetails, nmeaSentence, buildVoyage }
