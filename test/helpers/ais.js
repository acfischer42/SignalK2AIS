'use strict'

function sentence(body) {
  const checksum = Buffer.from(body, 'ascii').reduce((value, byte) => value ^ byte, 0)
  return `!${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}`
}

function reports({
  destination = 'VIENNA', shipType = 37, draft = 12, navigationStatus = 5,
  mmsi = 211123456, month = 11, day = 15, hour = 12, minute = 0,
  messageType = 1, sequence = '1', channel = 'A'
} = {}) {
  function encode(size, fields) {
    const bits = Array(size).fill('0')
    for (const [offset, width, value] of fields) {
      bits.splice(offset, width, ...value.toString(2).padStart(width, '0'))
    }
    const fill = (6 - size % 6) % 6
    const padded = bits.join('') + '0'.repeat(fill)
    let payload = ''
    for (let offset = 0; offset < padded.length; offset += 6) {
      const value = parseInt(padded.slice(offset, offset + 6), 2)
      payload += String.fromCharCode(value < 40 ? value + 48 : value + 56)
    }
    return { payload, fill }
  }
  const destinationFields = [...destination.padEnd(20, '@')].map((character, index) =>
    [302 + index * 6, 6, character.charCodeAt(0) & 63])
  const voyage = encode(424, [
    [0, 6, 5], [8, 30, mmsi], [232, 8, shipType],
    [274, 4, month], [278, 5, day], [283, 5, hour], [288, 6, minute],
    [294, 8, draft], ...destinationFields
  ])
  const navigation = encode(168, [[0, 6, messageType], [8, 30, mmsi], [38, 4, navigationStatus]])
  return {
    voyage: [
      sentence(`AIVDO,2,1,${sequence},${channel},${voyage.payload.slice(0, 60)},0`),
      sentence(`AIVDO,2,2,${sequence},${channel},${voyage.payload.slice(60)},${voyage.fill}`)
    ],
    navigation: sentence(`AIVDO,1,1,,${channel},${navigation.payload},${navigation.fill}`)
  }
}

module.exports = { reports, sentence }
