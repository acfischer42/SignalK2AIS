'use strict'

const { RequestError, nmeaSentence } = require('./voyage')

const STATES = { motoring: 0, anchored: 1, moored: 5, sailing: 8 }

function stateStatus(value) {
  return typeof value === 'string' && Object.hasOwn(STATES, value) ? STATES[value] : null
}

function statusSentence(status) {
  if (!Object.values(STATES).includes(status)) throw new RequestError('Unsupported navigation.state.')
  return nmeaSentence(`AIVSD,,,,,,,,${status},`)
}

function signalKDefaults(app) {
  const read = path => {
    const entry = app.getSelfPath(path)
    return entry && typeof entry === 'object' && Object.hasOwn(entry, 'value') ? entry.value : entry
  }
  const destination = read('navigation.destination.commonName')
  const eta = read('navigation.destination.eta')
  const parsedEta = typeof eta === 'string' ? new Date(eta) : null
  return {
    destination: typeof destination === 'string' ? destination : null,
    eta: parsedEta && Number.isFinite(parsedEta.getTime()) ? parsedEta.toISOString() : null
  }
}

module.exports = { stateStatus, statusSentence, signalKDefaults }
