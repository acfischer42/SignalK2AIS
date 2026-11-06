'use strict'

const { NAV_STATUSES, RequestError, integer, vesselDetails, buildVoyage } = require('./lib/voyage')
const { Readback, ReadbackError } = require('./lib/readback')
const { version } = require('./package.json')
const { stateStatus, statusSentence, signalKDefaults } = require('./lib/navigation')
const { Reminders } = require('./lib/reminders')

module.exports = function (app) {
  let running = false
  let settings
  let unsubscribe
  let ports = new Map()
  let lastSubmission = null
  let readback = new Readback()
  let inputEvent = null
  let stateUnsubscribes = []
  let navigationState = null
  let lastAutomaticStatus = null
  let lastStatusSubmission = null
  let reminders = null

  const plugin = {
    id: 'signalk-write-ais-nmea0183',
    name: 'SignalK2AIS',
    description: `SignalK2AIS v${version}. Submit AIS voyage data using an existing Signal K serial connection.`,
    schema: () => ({
      type: 'object',
      description: `Installed plugin version: ${version}`,
      required: ['providerId', 'regionalFlags'],
      properties: {
        enableVoyageReminders: {
          type: 'boolean', title: 'Enable departure and arrival reminders', default: false,
          description: 'Visual Signal K checklist notifications from the configured navigation.state source. Does not send AIS commands.'
        },
        reminderDelaySeconds: {
          type: 'integer', title: 'Reminder state stability delay (seconds)',
          default: 60, minimum: 1, maximum: 3600
        },
        navigationStateMode: {
          type: 'string', title: 'Use Signal K navigation.state',
          enum: ['manual', 'on-send', 'automatic'], default: 'manual',
          description: 'Manual: webapp selector. On-send: source-filtered navigation.state supplies status on Send. Automatic: also send status-only VSD on eligible state changes; other voyage fields stay unchanged.'
        },
        navigationStateSource: {
          type: 'string', title: 'navigation.state source label',
          default: 'signalk-autostate',
          description: 'Only updates from this exact source label or $source are used. AIS/VDO and this plugin are excluded.'
        },
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
        const navigationStateMode = options.navigationStateMode ?? 'manual'
        const navigationStateSource = options.navigationStateSource ?? 'signalk-autostate'
        const enableVoyageReminders = options.enableVoyageReminders ?? false
        if (typeof enableVoyageReminders !== 'boolean') throw new RequestError('Enable voyage reminders must be a boolean.')
        const reminderDelaySeconds = integer(options.reminderDelaySeconds ?? 60, 1, 3600, 'Reminder delay')
        if (!['manual', 'on-send', 'automatic'].includes(navigationStateMode) ||
            typeof navigationStateSource !== 'string' || !navigationStateSource.trim() ||
            /ais|vdo/i.test(navigationStateSource) || navigationStateSource === plugin.id) {
          throw new RequestError('Choose a valid navigation.state mode and a non-AIS source label.')
        }
        settings = { providerId: options.providerId, regionalFlags: options.regionalFlags, outputEvent, inputEvent: receiveEvent, navigationStateMode, navigationStateSource }
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
        if (enableVoyageReminders) {
          reminders = new Reminders((path, value) => {
            try {
              app.handleMessage(plugin.id, {
                context: `vessels.${app.selfId}`,
                updates: [{ source: { label: plugin.id }, timestamp: new Date().toISOString(), values: [{ path, value }] }]
              })
              return true
            } catch (error) {
              app.setPluginError(`Voyage reminder: ${error.message}`)
              app.error(`Voyage reminder: ${error.message}`)
              return false
            }
          }, reminderDelaySeconds * 1000)
        }
        if (navigationStateMode !== 'manual' || enableVoyageReminders) {
          app.subscriptionmanager.subscribe({
            context: 'vessels.self', subscribe: [{ path: 'navigation.state', period: 0 }]
          }, stateUnsubscribes, error => {
            app.setPluginError(`navigation.state subscription: ${error}`)
            app.error(`navigation.state subscription: ${error}`)
          }, receiveNavigationState)
        }
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
      if (reminders) reminders.stop()
      reminders = null
      stateUnsubscribes.forEach(unsubscribe => unsubscribe())
      stateUnsubscribes = []
      navigationState = null
      lastAutomaticStatus = null
      lastStatusSubmission = null
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
          diagnostics: diagnostics(),
          signalKDefaults: signalKDefaults(app),
          reminder: reminders?.active ?? null,
          navigationState: { mode: settings?.navigationStateMode ?? 'manual', source: settings?.navigationStateSource ?? null, current: navigationState, lastSubmission: lastStatusSubmission }
        })
      }))
      router.post('/reminders/clear', handle((req, res) => {
        requireRunning()
        requireSameOrigin(req)
        if (reminders && !reminders.clear()) throw new RequestError('Could not clear reminder; check server logs.', 503)
        res.set('Cache-Control', 'no-store').json({ message: 'Checklist reminder cleared. No AIS command sent.' })
      }))
      router.post('/preview', handle((req, res) => {
        requireRunning()
        requireSameOrigin(req)
        res.set('Cache-Control', 'no-store').json(
          buildVoyage(voyageInput(req.body), vesselDetails(app), settings.regionalFlags)
        )
      }))
      router.post('/voyage', handle((req, res) => {
        requireRunning()
        requireSameOrigin(req)
        const voyage = buildVoyage(voyageInput(req.body), vesselDetails(app), settings.regionalFlags)
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

  function voyageInput(input) {
    if (settings.navigationStateMode === 'manual') return input
    if (!navigationState) throw new RequestError('Waiting for supported navigation.state from the configured source.', 422)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input
    return { ...input, navigationStatus: navigationState.status }
  }

  function receiveNavigationState(delta) {
    if (!running || (delta.context && delta.context !== 'vessels.self' &&
        delta.context !== `vessels.${app.selfId}`)) return
    for (const update of delta.updates || []) {
      const source = update.source?.label || update.$source
      if (source !== settings.navigationStateSource) continue
      for (const value of update.values || []) {
        if (value.path !== 'navigation.state') continue
        if (navigationState?.timestamp && update.timestamp &&
            update.timestamp < navigationState.timestamp) continue
        const status = stateStatus(value.value)
        if (status === null) {
          reminders?.cancelPending()
          navigationState = null
          app.setPluginError(`Unsupported navigation.state: ${String(value.value)}`)
          app.error(`Unsupported navigation.state: ${String(value.value)}`)
          continue
        }
        navigationState = { value: value.value, status, source, timestamp: update.timestamp ?? null }
        reminders?.observe(status)
        if (settings.navigationStateMode !== 'automatic' || status === lastAutomaticStatus) continue
        try {
          const connection = outputConnection()
          if (!connection.available) throw new RequestError('AIS serial output unavailable for automatic status update.')
          if (readback.navigation?.navigationStatus === status) {
            lastAutomaticStatus = status
            continue
          }
          const sentence = statusSentence(status)
          if (!app.emit(connection.event, sentence)) throw new RequestError('No serial listener accepted automatic status update.')
          lastAutomaticStatus = status
          lastStatusSubmission = { sentence, status, source, submittedAt: new Date().toISOString() }
          console.log(`${plugin.id} TX status-only ${lastStatusSubmission.submittedAt} ${connection.event} ${sentence}`)
          app.setPluginStatus('Automatic status submitted; verify AIS acceptance. Other voyage fields unchanged.')
        } catch (error) {
          lastAutomaticStatus = status
          app.setPluginError(error.message)
          app.error(error.message)
        }
      }
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
