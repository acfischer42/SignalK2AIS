'use strict'

const base = new URL('../plugins/signalk-write-ais-nmea0183/', window.location.href)
const element = id => document.getElementById(id)
const form = element('voyage-form')
let state
let busy = false
let formRevision = 0
const editedFields = new Set()
const populatedFields = new Set()
const formFieldIds = new Set(['destination', 'eta', 'navigation-status', 'crew', 'passengers', 'other-personnel'])

element('timezone').textContent = `(${Intl.DateTimeFormat().resolvedOptions().timeZone})`

function message(text, error = false) {
  element('message').textContent = text
  element('message').className = error ? 'error' : 'success'
}

async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : {})
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('Access denied. Log in to the Signal K admin UI with an administrator account, then reload this page.')
  }
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error('The plugin API did not return JSON. Check installation and your Signal K login.')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
  return data
}

function updateButtons() {
  element('send-button').disabled = busy || !state?.running || !state?.connection.available
  element('send-button').textContent = busy ? 'Sending...' : 'Send to AIS'
}

function localEtaForNextOccurrence(eta, now = new Date()) {
  if (!eta || eta.month < 1 || eta.month > 12 || eta.day < 1 || eta.day > 31 ||
      eta.hour < 0 || eta.hour >= 24 || eta.minute < 0 || eta.minute >= 60) return ''
  let timestamp
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const candidate = new Date(Date.UTC(year, eta.month - 1, eta.day, eta.hour, eta.minute))
    if (candidate.getUTCMonth() !== eta.month - 1 || candidate.getUTCDate() !== eta.day) continue
    if (candidate.getTime() >= now.getTime()) {
      timestamp = candidate.getTime()
      break
    }
  }
  if (timestamp === undefined) return ''
  const date = new Date(timestamp)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function populateFieldOnce(id, value) {
  if (value === undefined || value === null || value === '' ||
      editedFields.has(id) || populatedFields.has(id)) return
  element(id).value = String(value)
  populatedFields.add(id)
}

function populateFormFromReadback(diagnostics) {
  const { voyage, navigation, personnel } = diagnostics
  populateFieldOnce('destination', voyage?.destination)
  populateFieldOnce('eta', localEtaForNextOccurrence(voyage?.eta))
  const navigationStatus = state?.navigationStatuses.find(item => item.id === navigation?.navigationStatus)
  populateFieldOnce('navigation-status', navigationStatus?.id)
  populateFieldOnce('crew', personnel?.crew)
  populateFieldOnce('passengers', personnel?.passengers)
  populateFieldOnce('other-personnel', personnel?.other)
}

function showLastSubmission(submission) {
  element('last-submission').textContent = submission
    ? `Last submitted here: ${submission.destination || 'Destination not available'} at ${new Date(submission.submittedAt).toLocaleString()}. Not confirmed by the AIS.`
    : 'No voyage submitted through this plugin since the server started.'
  element('tx-time').textContent = submission
    ? `${new Date(submission.submittedAt).toLocaleString()} | ${submission.submittedAt} | CRLF appended by serial provider`
    : 'No submission yet.'
  element('tx-sentence').textContent = submission
    ? (submission.sentences || [submission.sentence]).join('\n') : 'No outgoing sentence yet.'
}

function showDiagnostics(diagnostics) {
  const labels = {
    'no-submission': 'No command submitted yet. Received reports are shown below.',
    waiting: 'Submitted; no related post-submission readback yet.',
    partial: 'Partial readback; waiting for remaining voyage, navigation or Inland personnel fields.',
    mismatch: 'Readback differs from the latest submission. Check the fields below and the AIS display.',
    match: 'Matching readback for all compared fields. Returned PIWWIVD may be an echo; this is not a command acknowledgement.'
  }
  element('readback-status').textContent = labels[diagnostics.comparison.status]
  element('readback-status').dataset.status = diagnostics.comparison.status
  element('readback-source').textContent = diagnostics.inputEvent
    ? `Input event: ${diagnostics.inputEvent}. Set sentenceEvent to this value on the AIS connection only. Message 5 may take several minutes to arrive.`
    : 'Plugin disabled; readback monitoring is stopped.'
  const rx = diagnostics.lastRx
  element('rx-time').textContent = rx
    ? `${rx.receivedAt} | ${rx.complete ? 'Final/single fragment received; see decoded reports below.' : 'Incomplete multipart report; waiting for the remaining fragments.'}`
    : 'No related AIS sentence received yet.'
  const voyage = diagnostics.voyage
  element('voyage-rx-summary').textContent = voyage
    ? `${voyage.receivedAt} | MMSI ${voyage.mmsi} | ${voyage.destination} | ship type ${voyage.shipType} | draught ${voyage.draft.toFixed(1)} m | UTC ETA month/day ${voyage.eta.month}/${voyage.eta.day}, ${String(voyage.eta.hour).padStart(2, '0')}:${String(voyage.eta.minute).padStart(2, '0')} (AIS unknown values: month/day 0, hour 24, minute 60)`
    : 'No complete voyage report yet.'
  const navigation = diagnostics.navigation
  const navName = state?.navigationStatuses.find(item => item.id === navigation?.navigationStatus)?.name
  element('navigation-rx-summary').textContent = navigation
    ? `${navigation.receivedAt} | MMSI ${navigation.mmsi} | message ${navigation.messageType} | status ${navigation.navigationStatus} (${navName || 'Other/reserved'})`
    : 'No navigational-status report yet.'
  const personnel = diagnostics.personnel
  const count = value => value === undefined ? 'Not included' : value === null ? 'Unknown' : String(value)
  element('personnel-rx-summary').textContent = personnel
    ? `${personnel.receivedAt} | Crew: ${count(personnel.crew)} | Passengers: ${count(personnel.passengers)} | Other: ${count(personnel.other)}. Incoming PIWWIVD, not a storage acknowledgement.`
    : 'No PIWWIVD personnel report received yet. Counts remain waiting after an Inland submission until returned by the AIS.'
  const rows = element('readback-fields')
  rows.replaceChildren()
  for (const field of diagnostics.comparison.fields) {
    const row = document.createElement('tr')
    for (const value of [field.name, field.expected, field.actual ?? 'Waiting', field.status]) {
      const cell = document.createElement('td')
      cell.textContent = String(value)
      row.append(cell)
    }
    row.lastElementChild.dataset.status = field.status
    rows.append(row)
  }
  element('readback-table').hidden = diagnostics.comparison.fields.length === 0
  if (diagnostics.comparison.identityMatches === false) {
    element('readback-status').textContent += ' Voyage and navigational reports have different MMSIs.'
  }
  const error = diagnostics.lastError
  element('rx-error').hidden = !error
  element('rx-error').textContent = error
    ? `Readback rejected at ${error.receivedAt}: ${error.message}`
    : ''
}

async function loadState() {
  try {
    const next = await request('state')
    state = next
    element('plugin-version').textContent = `Running plugin version: ${state.version}`
    const vessel = state.vessel
    element('ship-type').textContent = vessel.shipType.id === null ? 'Unavailable'
      : `${vessel.shipType.name || 'Unnamed type'} (${vessel.shipType.id})`
    const metres = value => value === null ? 'Unavailable' : `${value.toFixed(2)} m`
    element('beam').textContent = metres(vessel.beam)
    element('length').textContent = metres(vessel.length)
    element('draft').textContent = metres(vessel.draft)
    const select = element('navigation-status')
    if (select.options.length === 1) {
      for (const status of state.navigationStatuses) select.add(new Option(status.name, String(status.id)))
    }
    populateFormFromReadback(state.diagnostics)
    element('connection').textContent = !state.running ? 'Plugin disabled: enable it in Plugin Config.'
      : state.connection.available
        ? `Serial output configured: ${state.connection.providerId} (${state.connection.event}). Regional flags: ${state.regionalFlags}. AIS acceptance is not monitored.`
        : `Serial output unavailable for "${state.connection.providerId}". Known IDs: ${state.connection.knownSerialConnections.join(', ') || 'none'}.`
    showLastSubmission(state.lastSubmission)
    showDiagnostics(state.diagnostics)
  } catch (error) {
    state = undefined
    element('plugin-version').textContent = 'Running plugin version: unavailable (server could not be reached)'
    element('connection').textContent = 'Signal K data unavailable.'
    element('readback-status').textContent = 'Diagnostics unavailable; previously displayed values may be stale.'
    element('readback-status').dataset.status = 'waiting'
    message(error.message, true)
  }
  updateButtons()
}

form.addEventListener('input', event => {
  if (formFieldIds.has(event.target?.id)) editedFields.add(event.target.id)
  formRevision++
  updateButtons()
})

element('personnel-mode').addEventListener('change', () => {
  const inland = element('personnel-mode').value === 'inland'
  element('inland-personnel').hidden = !inland
  element('inland-personnel').disabled = !inland
  element('maritime-personnel').hidden = inland
  element('persons').disabled = inland
  formRevision++
  updateButtons()
})

function personnelInput() {
  const count = id => element(id).value === '' ? null : Number(element(id).value)
  return element('personnel-mode').value === 'inland'
    ? { inlandPersonnel: {
      crew: count('crew'),
      passengers: count('passengers'),
      other: count('other-personnel')
    } }
    : { personsOnBoard: count('persons') }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy || !state?.running || !state?.connection.available || !form.reportValidity()) return
  const revision = formRevision
  busy = true
  updateButtons()
  let submitted = false
  try {
    const localEta = element('eta').value
    const eta = localEta ? new Date(localEta) : null
    // Reject local times that the browser silently moves across a DST gap.
    const pad = value => String(value).padStart(2, '0')
    const localRoundTrip = eta ? `${eta.getFullYear()}-${pad(eta.getMonth() + 1)}-${pad(eta.getDate())}T${pad(eta.getHours())}:${pad(eta.getMinutes())}` : ''
    if (eta && (!Number.isFinite(eta.getTime()) || localRoundTrip !== localEta)) {
      throw new Error('Arrival time is invalid or falls in a daylight-saving clock gap.')
    }
    const input = {
      destination: element('destination').value,
      eta: eta ? eta.toISOString() : null,
      navigationStatus: Number(element('navigation-status').value),
      ...personnelInput()
    }
    // Validate without a user-facing preview, retaining server-side stale-data checks.
    const validated = await request('preview', input)
    if (formRevision !== revision) {
      throw new Error('Form changed while preparing the command. Nothing was sent; send again.')
    }
    submitted = true
    const result = await request('voyage', {
      ...input, confirmedSentence: validated.sentence, confirmedSentences: validated.sentences
    })
    showLastSubmission(result)
    state.lastSubmission = result
    showDiagnostics({
      ...state.diagnostics,
      comparison: { status: 'waiting', fields: [] }
    })
    message(result.message)
  } catch (error) {
    message(submitted
      ? `${error.message}\nIf the connection failed during submission, check the AIS display before retrying.`
      : error.message, true)
  } finally {
    busy = false
    updateButtons()
  }
})

loadState()
element('refresh-diagnostics').addEventListener('click', () => { if (!busy) loadState() })
const refresh = window.setInterval(() => { if (!busy) loadState() }, 10000)
window.addEventListener('pagehide', () => window.clearInterval(refresh))
