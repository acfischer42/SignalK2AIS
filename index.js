'use strict'

const { NAV_STATUSES, RequestError, integer, vesselDetails, buildVoyage } = require('./lib/voyage')
const { Readback, ReadbackError } = require('./lib/readback')
const { version } = require('./package.json')

module.exports = function (app) {
  let running = false
  let settings
  let unsubscribe
  let ports = new Map()
  let lastSubmission = null
  let readback = new Readback()
  let inputEvent = null

  const plugin = {
    id: 'signalk-write-ais-nmea0183',
    name: 'SignalK2AIS',
    description: `SignalK2AIS v${version}. Submit AIS voyage data using an existing Signal K serial connection.`,
    schema: () => ({
      type: 'object',
      description: `Installed plugin version: ${version}`,
      required: ['providerId', 'regionalFlags'],
      properties: {
        providerId: {
          type: 'string',
          title: 'Data Connection ID',
          description: 'The ID of your existing NMEA 0183 serial data connection (not /dev/ttyAIS).',
          default: 'ais',
          pattern: '^[A-Za-z0-9_-]+$'
        },
        regionalFlags: {
          type: 'integer', title: 'Regional application flags',
          description: 'VSD field 9. Verify for your installation; ordinarily 0.',
          default: 0, minimum: 0, maximum: 15
        },
        outputEvent: {
          type: 'string', title: 'Explicit serial output event (older servers)',
          description: 'Leave empty for discovery. On older servers set ais-voyage-out here and as toStdout on the AIS connection only.',
          default: '', pattern: '^$|^ais-voyage-[A-Za-z0-9_-]+$'
        },
        inputEvent: {
          type: 'string', title: 'AIS input sentence event',
          description: 'Set this event as sentenceEvent on the AIS connection only. Never use global nmea0183 for readback.',
          default: 'ais-voyage-in', pattern: '^ais-voyage-[A-Za-z0-9_-]+$'
        }
      }
    }),
    start(options) {
      plugin.stop()
      try {
        if (!options || typeof options.providerId !== 'string' ||
            !/^[A-Za-z0-9_-]+$/.test(options.providerId) ||
            options.providerId.trim() !== options.providerId) {
          throw new RequestError('Configure a valid Data Connection ID for the AIS serial connection.')
        }
        integer(options.regionalFlags, 0, 15, 'Regional application flags')
        const outputEvent = options.outputEvent ?? ''
        if (typeof outputEvent !== 'string' || !/^$|^ais-voyage-[A-Za-z0-9_-]+$/.test(outputEvent) ||
            outputEvent.trim() !== outputEvent) {
          throw new RequestError('Explicit output event must be empty or start with ais-voyage- and contain letters, digits, underscores or hyphens.')
        }
        const receiveEvent = options.inputEvent ?? 'ais-voyage-in'
        if (typeof receiveEvent !== 'string' || !/^ais-voyage-[A-Za-z0-9_-]+$/.test(receiveEvent) ||
            receiveEvent.trim() !== receiveEvent || receiveEvent === outputEvent ||
            receiveEvent.endsWith('-toStdout')) {
          throw new RequestError('Input event must start with ais-voyage- and be different from the serial output event.')
        }
        settings = { providerId: options.providerId, regionalFlags: options.regionalFlags, outputEvent, inputEvent: receiveEvent }
        inputEvent = receiveEvent
        app.on(inputEvent, receiveSentence)
        unsubscribe = app.onPropertyValues('serialport', history => {
          ports = new Map()
          for (const property of history) {
            const port = property?.value
            if (typeof port?.id === 'string' && typeof port?.eventNames?.toStdout === 'string') {
              ports.set(port.id, port.eventNames.toStdout)
            }
          }
        })
        running = true
        app.setPluginStatus('Ready for manual voyage submissions; AIS acceptance must be checked on its display.')
      } catch (error) {
        plugin.stop()
        app.setPluginError(error.message)
        app.error(error.message)
        throw error
      }
    },
    stop() {
      running = false
      if (inputEvent) app.removeListener(inputEvent, receiveSentence)
      inputEvent = null
      if (unsubscribe) unsubscribe()
      unsubscribe = undefined
      ports.clear()
      settings = undefined
      readback = new Readback()
      lastSubmission = null
    },
    registerWithRouter(router) {
      // Signal K protects plugin routes with admin authentication.
      router.get('/state', handle((req, res) => {
        const connection = outputConnection()
        res.set('Cache-Control', 'no-store').json({
          running, version, vessel: vesselDetails(app), navigationStatuses: NAV_STATUSES,
          connection, regionalFlags: settings?.regionalFlags ?? null, lastSubmission,
          diagnostics: diagnostics()
        })
      }))
      router.post('/preview', handle((req, res) => {
        requireRunning()
        requireSameOrigin(req)
        res.set('Cache-Control', 'no-store').json(
          buildVoyage(req.body, vesselDetails(app), settings.regionalFlags)
        )
      }))
      router.post('/voyage', handle((req, res) => {
        requireRunning()
        requireSameOrigin(req)
        const voyage = buildVoyage(req.body, vesselDetails(app), settings.regionalFlags)
        const confirmed = voyage.inlandPersonnel
          ? JSON.stringify(req.body.confirmedSentences) === JSON.stringify(voyage.sentences)
          : req.body.confirmedSentence === voyage.sentence
        if (!confirmed) {
          throw new RequestError('Voyage data changed or was not previewed. Preview and confirm again.', 409)
        }
        const connection = outputConnection()
        if (!connection.available) {
          throw new RequestError('AIS serial output is unavailable. Check the configured connection ID and enable that connection.', 503)
        }
        const submittedSentences = []
        // The serial provider appends CRLF to each string.
        for (const sentence of voyage.sentences) {
          try {
            if (!app.emit(connection.event, sentence)) {
              throw new RequestError('No AIS serial output listener accepted the event.', 503)
            }
          } catch (error) {
            app.error(`AIS submission interrupted after ${submittedSentences.length}/${voyage.sentences.length} sentences: ${error.message}`)
            throw new RequestError(
              `AIS submission interrupted after ${submittedSentences.length}/${voyage.sentences.length} sentences. Check the AIS display before retrying.`,
              503
            )
          }
          submittedSentences.push(sentence)
          console.log(`${plugin.id} TX submitted ${new Date().toISOString()} ${connection.event} ${sentence}`)
        }
        lastSubmission = { ...voyage, submittedAt: new Date().toISOString() }
        readback.markSubmission()
        app.setPluginStatus('Voyage submitted to Signal K serial output; check the AIS display for acceptance.')
        res.status(202).set('Cache-Control', 'no-store').json({
          ...lastSubmission,
          message: 'Submitted to Signal K serial output. Not an AIS acknowledgement: verify Voyage Data on the AIS display.'
        })
      }))
    }
  }

  function receiveSentence(sentence) {
    if (!running) return
    try {
      const result = readback.receive(sentence)
      if (result) {
        console.log(`${plugin.id} RX ${readback.lastRx.receivedAt} ${inputEvent} ${result.sentence}`)
      }
    } catch (error) {
      app.error(`AIS readback: ${error.message}`)
      if (!(error instanceof ReadbackError)) app.setPluginError(error.message)
    }
  }

  function diagnostics() {
    return {
      inputEvent, lastRx: readback.lastRx, voyage: readback.voyage,
      navigation: readback.navigation, personnel: readback.personnel, lastError: readback.lastError,
      comparison: readback.comparison(lastSubmission)
    }
  }

  function outputConnection() {
    const providerId = settings?.providerId ?? null
    const event = settings?.outputEvent || ports.get(providerId) || null
    // Some Signal K plugin API wrappers expose emit/on but not listenerCount.
    const hasListener = event !== null &&
      (typeof app.listenerCount !== 'function' || app.listenerCount(event) > 0)
    return {
      providerId, event,
      available: running && hasListener,
      explicitEvent: Boolean(settings?.outputEvent),
      knownSerialConnections: [...ports.keys()]
    }
  }

  function requireRunning() {
    if (!running) throw new RequestError('Enable and configure the SignalK2AIS plugin first.', 503)
  }

  function requireSameOrigin(req) {
    if (req.get('Sec-Fetch-Site') === 'cross-site') {
      throw new RequestError('Cross-site voyage writes are not allowed.', 403)
    }
    const origin = req.get('Origin')
    if (origin) {
      let host
      try {
        host = new URL(origin).host
      } catch {
        throw new RequestError('Invalid request origin.', 403)
      }
      if (host !== req.get('Host')) throw new RequestError('Cross-site voyage writes are not allowed.', 403)
    }
  }

  function handle(handler) {
    return (req, res) => {
      try {
        handler(req, res)
      } catch (error) {
        app.error(error.message)
        if (!(error instanceof RequestError)) app.setPluginError(error.message)
        res.status(error instanceof RequestError ? error.status : 500).json({
          error: error instanceof RequestError ? error.message : 'AIS operation failed. Check the Signal K server log.'
        })
      }
    }
  }

  return plugin
}
