'use strict'

const { nmeaSentence } = require('./voyage')

class ReadbackError extends Error {}

function payloadBits(payload) {
  if (!/^[0-W`-w]+$/.test(payload)) throw new ReadbackError('Invalid AIS six-bit payload.')
  return [...payload].map(character => {
    let value = character.charCodeAt(0) - 48
    if (value > 40) value -= 8
    return value.toString(2).padStart(6, '0')
  }).join('')
}

function decodeReport(bits) {
  const number = (start, width) => parseInt(bits.slice(start, start + width), 2)
  const messageType = number(0, 6)
  if (![1, 2, 3, 5].includes(messageType)) return null
  if (bits.length !== (messageType === 5 ? 424 : 168)) {
    throw new ReadbackError(`AIS message ${messageType} has an invalid bit length.`)
  }
  const mmsi = String(number(8, 30)).padStart(9, '0')
  if (messageType !== 5) return { messageType, mmsi, navigationStatus: number(38, 4) }
  let destination = ''
  for (let offset = 302; offset < 422; offset += 6) {
    const value = number(offset, 6)
    destination += String.fromCharCode(value < 32 ? value + 64 : value)
  }
  return {
    messageType, mmsi,
    shipType: number(232, 8),
    draft: number(294, 8) / 10,
    destination: destination.replace(/[@ ]+$/, ''),
    eta: {
      month: number(274, 4), day: number(278, 5),
      hour: number(283, 5), minute: number(288, 6)
    }
  }
}

class Readback {
  constructor() {
    this.pending = new Map()
    this.lastRx = null
    this.voyage = null
    this.navigation = null
    this.personnel = null
    this.lastError = null
    this.submissionSequence = 0
  }

  markSubmission() {
    this.submissionSequence++
    this.pending.clear()
  }

  receive(value, now = Date.now()) {
    const sentence = Buffer.isBuffer(value) ? value.toString('ascii').trim()
      : typeof value === 'string' ? value.trim() : ''
    // Only the dedicated AIS input route supplies own-vessel reports.
    if (!sentence.startsWith('!AIVDO,') && !sentence.startsWith('$PIWWIVD,')) return null
    try {
      if (sentence.startsWith('$PIWWIVD,')) return this.receivePersonnel(sentence, now)
      for (const [key, pending] of this.pending) {
        if (now - pending.startedAt > 30000) this.pending.delete(key)
      }
      const match = /^!AIVDO,([1-9]),([1-9]),([0-9]?),([AB]?),([0-W`-w]{1,80}),([0-5])\*([0-9A-Fa-f]{2})$/.exec(sentence)
      if (!match) throw new ReadbackError('Invalid AIVDO sentence format.')
      const expected = nmeaSentence(sentence.slice(1, -3)).slice(-2)
      if (expected !== match[7].toUpperCase()) throw new ReadbackError('AIVDO checksum mismatch.')
      const total = Number(match[1])
      const fragment = Number(match[2])
      const fill = Number(match[6])
      const key = `${match[3]}:${match[4]}`
      if (fragment > total || (fragment !== total && fill !== 0)) {
        throw new ReadbackError('Invalid AIVDO fragment numbering or fill bits.')
      }
      let pending
      if (fragment === 1) {
        const messageType = parseInt(payloadBits(match[5]).slice(0, 6), 2)
        if (this.pending.has(key)) {
          this.pending.delete(key)
          throw new ReadbackError('Ambiguous AIVDO fragments: repeated first fragment.')
        }
        pending = {
          total, next: 1, payload: '', sentences: [], startedAt: now,
          supported: [1, 2, 3, 5].includes(messageType),
          submissionSequence: this.submissionSequence
        }
        if (total > 1) {
          if (this.pending.size >= 16) throw new ReadbackError('Too many incomplete AIVDO reports.')
          this.pending.set(key, pending)
        }
      } else {
        pending = this.pending.get(key)
        if (!pending) throw new ReadbackError('AIVDO continuation without a recent first fragment.')
      }
      if (pending.total !== total || pending.next !== fragment) {
        this.pending.delete(key)
        throw new ReadbackError('AIVDO fragments are out of order or inconsistent.')
      }
      pending.next++
      pending.payload += match[5]
      pending.sentences.push(sentence)
      if (fragment !== total) {
        if (!pending.supported) return null
        this.lastRx = { sentence, receivedAt: new Date(now).toISOString(), complete: false }
        this.lastError = null
        return { sentence, complete: false }
      }
      this.pending.delete(key)
      let bits = payloadBits(pending.payload)
      if (fill > 0) {
        if (bits.slice(-fill).includes('1')) throw new ReadbackError('Non-zero AIVDO padding.')
        bits = bits.slice(0, -fill)
      }
      const decoded = decodeReport(bits)
      if (!decoded) return null
      this.lastRx = { sentence, receivedAt: new Date(now).toISOString(), complete: true }
      this.lastError = null
      const report = {
        ...decoded, sentences: pending.sentences,
        submissionSequence: pending.submissionSequence,
        startedAt: new Date(pending.startedAt).toISOString(),
        receivedAt: new Date(now).toISOString()
      }
      if (decoded.messageType === 5) this.voyage = report
      else this.navigation = report
      return { sentence, complete: true, report }
    } catch (error) {
      if (!(error instanceof ReadbackError)) throw error
      this.lastError = { message: error.message, sentence, receivedAt: new Date(now).toISOString() }
      // Invalid input must not be combined with later fragments.
      this.pending.clear()
      throw error
    }
  }

  receivePersonnel(sentence, now) {
    const match = /^\$PIWWIVD,([^*\r\n]*)\*([0-9A-Fa-f]{2})$/.exec(sentence)
    if (!match) throw new ReadbackError('Invalid PIWWIVD sentence format.')
    if (nmeaSentence(sentence.slice(1, -3)).slice(-2) !== match[2].toUpperCase()) {
      throw new ReadbackError('PIWWIVD checksum mismatch.')
    }
    const fields = match[1].split(',')
    if (fields.length !== 13) throw new ReadbackError('PIWWIVD must contain 13 fields.')
    const count = (index, max, label) => {
      const value = fields[index]
      if (value === '') return undefined
      if (!/^\d+$/.test(value) || Number(value) > max) {
        throw new ReadbackError(`Invalid PIWWIVD ${label} count.`)
      }
      return Number(value) === max ? null : Number(value)
    }
    const crew = count(6, 255, 'crew')
    const passengers = count(7, 8191, 'passengers')
    const other = count(8, 255, 'other personnel')
    if ([crew, passengers, other].every(value => value === undefined)) return null
    // Do not merge omitted fields with old reports: they are not fresh readback.
    const report = {
      crew, passengers, other, sentences: [sentence],
      submissionSequence: this.submissionSequence,
      startedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString()
    }
    this.personnel = report
    this.lastRx = { sentence, receivedAt: report.receivedAt, complete: true }
    this.lastError = null
    return { sentence, complete: true, report }
  }

  comparison(submission) {
    if (!submission) return { status: 'no-submission', fields: [] }
    const fresh = report => report && report.submissionSequence === this.submissionSequence &&
      report.startedAt >= submission.submittedAt
    const voyage = fresh(this.voyage) ? this.voyage : null
    const navigation = fresh(this.navigation) ? this.navigation : null
    const personnel = fresh(this.personnel) ? this.personnel : null
    const eta = submission.eta ? new Date(submission.eta) : null
    const field = (name, expected, actual) => ({
      name, expected, actual: actual ?? null,
      status: actual === undefined ? 'waiting' : actual === expected ? 'match' : 'mismatch'
    })
    const fields = [
      field('Destination', submission.destination, voyage?.destination),
      field('Ship type', submission.shipType.id, voyage?.shipType),
      field('Draught (m)', submission.draft, voyage?.draft),
      field('ETA month (UTC)', eta ? eta.getUTCMonth() + 1 : 0, voyage?.eta.month),
      field('ETA day (UTC)', eta ? eta.getUTCDate() : 0, voyage?.eta.day),
      field('ETA hour (UTC)', eta ? eta.getUTCHours() : 24, voyage?.eta.hour),
      field('ETA minute (UTC)', eta ? eta.getUTCMinutes() : 60, voyage?.eta.minute),
      field('Navigational status', submission.navigationStatus, navigation?.navigationStatus)
    ]
    if (submission.inlandPersonnel) {
      for (const [key, label] of [['crew', 'Crew'], ['passengers', 'Passengers'], ['other', 'Other personnel']]) {
        const expected = submission.inlandPersonnel[key]
        const actual = personnel?.[key]
        fields.push(field(label, expected === null ? 'Unknown' : expected,
          actual === null ? 'Unknown' : actual))
      }
    }
    const identityMatches = !voyage || !navigation || voyage.mmsi === navigation.mmsi
    const status = !identityMatches || fields.some(item => item.status === 'mismatch') ? 'mismatch'
      : fields.every(item => item.status === 'match') ? 'match'
        : voyage || navigation || (submission.inlandPersonnel && personnel) ? 'partial' : 'waiting'
    return { status, fields, identityMatches }
  }
}

module.exports = { Readback, ReadbackError }
