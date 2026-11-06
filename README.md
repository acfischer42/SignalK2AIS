# SignalK2AIS

[![SignalK Plugin CI](https://github.com/acfischer42/SignalK2AIS/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/acfischer42/SignalK2AIS/actions/workflows/signalk-ci.yml)
[![npm version](https://img.shields.io/npm/v/signalk-write-ais-nmea0183)](https://www.npmjs.com/package/signalk-write-ais-nmea0183)

A Signal K server plugin and bundled webapp for manually setting an Oceansat
transponder's destination, ETA and navigational status over NMEA 0183. It reuses
the existing Signal K serial connection: no second serial open, shell commands
or direct access to `/dev/ttyAIS`.

## Install

When published, install **SignalK2AIS** from the Signal K App Store. Its npm
package name remains `signalk-write-ais-nmea0183` for compatibility with existing
installations. The plugin stays disabled until you configure its AIS connection.

Requires Node.js 18 or later and Signal K's plugin API. Supports advertised
connection-specific serial output events, or explicit `toStdout` routing on older
servers (verified against the Signal K 2.13.0 serial provider source).

From this repository:

```sh
npm test
npm run check
npm pack
```

Copy the resulting `signalk-write-ais-nmea0183-0.1.14.tgz` to your GX. In the
**Signal K configuration directory** (the directory containing its `settings.json`
and `node_modules`, not necessarily `/data`), run:

```sh
npm install /path/to/signalk-write-ais-nmea0183-0.1.14.tgz
```

Restart Signal K. Under **Server -> Plugin Config -> SignalK2AIS**, configure:

- **Data Connection ID**: the provider ID of your existing AIS NMEA 0183
  serial data connection. The example/default is `ais`; use your actual ID.
- **Regional application flags**: normally `0`; verify for your installation.
  This field is always sent and must be an integer from 0 to 15.
- **Explicit serial output event**: leave empty on servers advertising their
  serial events. For older versions, follow the explicit routing setup below.
- **AIS input sentence event**: `ais-voyage-in`; route this event from the AIS
  connection as described under diagnostics below.

Enable the plugin. Open **Webapps -> SignalK2AIS**, or visit:

```text
http://YOUR-GX:3000/signalk-write-ais-nmea0183/
```

The webapp header displays the running backend's package version, refreshed with
server state. Plugin Config also includes the version in the plugin description
and configuration schema description. Both use `package.json`, not an editable
setting. After upgrading, restart Signal K and hard-refresh the webapp to load
the latest frontend files. The displayed backend version is not a frontend cache
version; it does not prove that cached browser assets are current.

The bundled `public/icon.svg` is used in the header, browser tab and Signal K
Webapps list (via `signalk.appIcon` in `package.json`). Restart Signal K and reload
its admin page after upgrading to refresh the webapp metadata.
An identical root `icon.svg` is included for package-relative App Store/CDN
lookups; tests ensure it matches the public copy.

Use an administrator login in the Signal K admin UI on the **same origin** first.
The server's plugin router provides authentication; do not expose write access
on an unsecured/public Signal K instance.

## CI and npm releases

An empty startup configuration leaves the plugin explicitly unconfigured with
all AIS writes disabled; partial or invalid configuration still reports errors.
The App Store screenshot uses fictional demonstration values. Matching copies
at the package root and in `public/` support both CDN and Webapps asset lookup.

See the repository's [publishing guide](https://github.com/acfischer42/SignalK2AIS/blob/main/publishing.md) for the step-by-step release checklist,
trusted-publisher configuration, Ekrano installation and troubleshooting.

Source and workflows: [acfischer42/SignalK2AIS](https://github.com/acfischer42/SignalK2AIS).

### Continuous integration

`.github/workflows/signalk-ci.yml` calls Signal K's reusable plugin CI on pushes
to `main`, pull requests to `main`, and manual dispatch. The pinned reusable
workflow runs the tests and plugin checks on Linux x64/arm64, macOS and Windows,
using Node 22, 24 and 26. Our `npm run check` is its build step; no frontend
compilation or install-time script is needed. This is simulated API/lifecycle
testing, not a test of a physical transponder. Node 18 remains the package
minimum; the shared workflow only supports testing current Signal K runtimes.

Reusable workflows and checkout/setup actions are pinned to commit SHAs.
Update those pins deliberately when adopting upstream changes.

### One-time npm trusted-publisher setup

The first release must be published by an authenticated npm maintainer, since
the package must exist before its trusted publisher can be configured:

```sh
npm login
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run
npm publish --access public
```

In the npm package **Settings -> Trusted Publisher**, select **GitHub Actions**:

- Organization/user: `acfischer42`
- Repository: `SignalK2AIS`
- Workflow filename: `publish.yml`
- Environment: `npm`

Enable direct publishing (`npm publish`) in **Allowed actions**; separate
dist-tag management is not required. Stage-only access would require a
different release workflow with manual npm approval.

The GitHub repository needs an environment named `npm` (created for this
repository). You can add required reviewers there to approve releases.
No npm access token or `NPM_TOKEN` secret is needed for subsequent releases.
Use npm account 2FA and complete any browser/OTP confirmation privately.

### Subsequent releases

1. Update `CHANGELOG.md` and the package version on `main` (`npm version patch
   --no-git-tag-version` updates both manifests); commit and push.
2. Wait for **SignalK Plugin CI** to pass.
3. Tag that commit with the exact package version and push the tag:

   ```sh
   git tag v0.1.13
   git push origin v0.1.13
   ```

`.github/workflows/publish.yml` runs the full shared CI again for the tag. Only
if it passes does the `npm` environment job publish with OIDC trusted publishing
and provenance. The tag must match `package.json`. The workflow runs on
GitHub-hosted runners with Node 24 (npm 11.5.1+ is required for trusted
publishing); it has no hardware access. A manual run on a branch tests only;
a manual run on a version tag can retry a failed publication.
Never reuse an npm version that has already been published.

Optionally create a GitHub Release for each tag. The App Store can show the
included `CHANGELOG.md` and the shared CI results for published versions.
Discovery after npm publication is not necessarily immediate.

References: [Signal K App Store publishing](https://demo.signalk.org/documentation/Developing/Plugins/Publishing_to_The_AppStore.html),
[Signal K plugin CI](https://demo.signalk.org/documentation/Developing/Plugins/Plugin_CI/CD.html),
and [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## Configure the existing serial connection

Keep the existing AIS input connection enabled while using the webapp. It should
already read `/dev/ttyAIS` at **38400 baud**. Do not create another connection to
the same device and do not run terminal writers at the same time.

The serial provider publishes a `serialport` property value containing its
`id` and `eventNames.toStdout`. The plugin discovers that event for the configured
ID (typically `serial-ais-toStdout`) and emits the completed sentence on it.
The provider appends CRLF. You do **not** need `signalk-to-nmea0183` or to route
the global `nmea0183out` stream to the AIS.

If output is unavailable, the webapp lists discovered serial connection IDs.
Check your existing connection's `options.subOptions.providerId` in
`settings.json` if the admin UI does not show its ID. For example, the relevant
portion of an existing connection may be:

```json
{
  "type": "providers/simple",
  "options": {
    "type": "NMEA0183",
    "providerId": "ais",
    "subOptions": {
      "type": "serial",
      "providerId": "ais",
      "device": "/dev/ttyAIS",
      "baudrate": 38400
    }
  }
}
```

This is a reference fragment, **not** a replacement `settings.json`.

### Older servers: explicit routing

If no serial connection IDs are discovered, older Signal K versions such as
2.13.0 support serial output through a configured `toStdout` event instead:

1. Back up `settings.json` and stop Signal K before manually editing it.
2. Add `"toStdout": "ais-voyage-out"` to **only your existing AIS connection's
   `options.subOptions`**, alongside `device` and `baudrate`.
   If `toStdout` already exists, preserve it by using an array of event names,
   adding `"ais-voyage-out"` to that array.
3. Restart Signal K. Set **Explicit serial output event** in this plugin to
   `ais-voyage-out` and retain the AIS connection ID for identification.

This still uses the same serial provider and never opens the tty separately.
Do not attach this event to any other output connection. The plugin does not
rewrite your server configuration. In explicit mode the webapp can show that
an output route is configured, but cannot inspect routing on server API wrappers
without `listenerCount`. Emitting with no listener fails explicitly; having a
listener is not proof of device connectivity.

The adapter's transmit pair must connect to the AIS receive pair on a supported
bidirectional port, such as **External Display**. AIS sensor-only inputs do not
accept VSD. Successful reception in Signal K proves only AIS-to-GX wiring.
Keep the existing Venus OS `serial-starter` ignore rule.

## Vessel data and voyage fields

### Departure and arrival reminders

Enable **Enable departure and arrival reminders** in Plugin Config (off by
default). Reminders use the configured `navigation.state` source, defaulting to
`signalk-autostate`, independently of the AIS status mode: they also work in
manual mode without sending any AIS commands.

The first supported state establishes a baseline without notifying. A transition
between stopped (moored/anchored) and moving (motoring/sailing) must remain stable
for **Reminder state stability delay**, default 60 seconds. Repeated state
reports do not restart that timer; reversals and unsupported states cancel it.
Switching between motoring and sailing does not generate another departure.

A visual `alert` is published at `notifications.aisVoyage.checklist`, asking you
to check destination, ETA and persons on departure or review voyage data on
arrival. The message includes `/signalk-write-ais-nmea0183/`; an optional `href`
field provides the same relative link. Clickable links depend on the receiving
client; clients that only display plain text may require opening the app manually.
No sound or phone push routing is configured.

The app shows an active reminder and a **Checklist reviewed** button. This clears
the notification with a null delta and does not send an AIS command. Sending
voyage data does not dismiss the checklist. A new transition replaces the previous
reminder. Stopping/disabling/reconfiguring the plugin clears its active reminder
and cancels pending timers. Restarting establishes a fresh baseline.
Missing-readback warnings are not included in this feature.

### Signal K voyage fallback and Auto-state integration

When no own-vessel message 5 has arrived since restart, the form can use
`navigation.destination.commonName` and `navigation.destination.eta` from Signal K.
Direct AIS voyage readback takes precedence when available at initial fill.
Fields are filled once; user edits are never overwritten. Signal K values may
be stale: check the form before sending. No requested voyage value is published
as if confirmed: the existing Signal K VDO parser continues to publish actual
AIS readback. This plugin adds no duplicate Signal K publisher.

**Use Signal K navigation.state** in Plugin Config has three modes:

- `manual` (default): choose status in the webapp, preserving existing behavior.
- `on-send`: use the latest supported `navigation.state` from the configured
  source when pressing Send; the status selector is locked.
- `automatic`: also submit a status-only VSD when that source reports a changed
  status. It can submit immediately on the first eligible report after startup.
  Destination, ETA, ship type, draught, persons and regional flags are null wire
  fields meaning unchanged, not unavailable. No PIWWIVD is sent automatically.
  **Verify your AIS firmware accepts this partial VSD before relying on it.**

The source label defaults to `signalk-autostate`, matching
[`@meri-imperiumi/signalk-autostate`](https://github.com/meri-imperiumi/signalk-autostate).
That plugin emits `motoring` (AIS 0), `anchored` (1), `moored` (5) or `sailing`
(8). Set its default propulsion appropriately for your vessel. Only the exact
configured `source.label` (or `$source` when there is no label) is accepted.
Other vessels, AIS/VDO sources and this plugin's own source are excluded; an
unsupported value reports an error and blocks on-send use until a supported
value arrives. The plugin waits for a source update instead of assuming that
the current global datapoint came from Auto-state.

Repeated identical status reports do not retransmit, including Auto-state's
periodic refreshes. If the last own-vessel status already matches, no automatic
command is needed. A failed submission is logged and shown as a plugin error,
without automatic retry of the same state (check hardware before restarting
or changing modes). Subscription handlers are removed on stop/reconfiguration.
Last automatic submission is shown in diagnostics separately from full voyage
submissions; neither is proof of AIS acceptance. Automatic mode does not change
the full voyage submission or comparison history.

The webapp refreshes read-only vessel data every 10 seconds, and the backend reads
it again for both preview and submission:

| Signal K path | Value used | Example |
| --- | --- | --- |
| `design.aisShipType` | `id` and display `name` | `{ "name": "Pleasure", "id": 37 }` |
| `design.beam` | metres | `4.10` |
| `design.draft` | `maximum`, metres | `{ "maximum": 1.2 }` |
| `design.length` | `overall`, metres | `{ "overall": 21.6 }` |

Values are not hardcoded. Missing ship type or maximum draught blocks writes;
missing beam/length is displayed as unavailable. VSD contains ship type and
draught but **not beam or length**. The plugin deliberately does not send SSD:
updating identity/dimensions requires additional reference-point information and
is outside its scope. Draught is encoded to the nearest 0.1 metre.

Editable fields:

- Destination, ETA and navigational status are filled from received AIS
  readback when available; Inland counts are filled from PIWWIVD readback.
  Each field is populated at most once and is never overwritten after you edit
  it. If data has not been read back, the field stays blank.
- AIS does not transmit the ETA year. When filling the date/time input, the
  webapp uses the next occurrence of the reported month/day and UTC time,
  converted to local time. Verify the inferred date before sending.
- Destination: optional, up to 20 characters, trimmed and converted to uppercase. Supports
  letters, digits, spaces and `. / ' ( ) + -`. Invalid characters are rejected,
  never silently removed or truncated.
- Estimated arrival: local date/time selector; converted to UTC with seconds
  set to zero. AIS carries month/day/time, **not year**.
  Invalid calendar dates and daylight-saving clock gaps are rejected. In an
  autumn clock overlap the browser chooses the first occurrence: verify UTC in
  the form before sending.
- Navigational status: the Oceansat menu's supported values, including engine
  (0), anchor (1), moored (5), sailing (8) and undefined (15).
- Persons on board: explicitly entered integer from 0 to 8191. No assumed crew
  count. Zero means unavailable in AIS usage, not necessarily an empty vessel.

### Inland personnel

Select **Personnel mode -> Inland** to replace the maritime total input with
three optional counts: **crew** (0–254), **passengers** (0–8190), and **other
personnel** (0–254). Zero means none; blank means unknown.
Inland is the default. Select Maritime explicitly to send only VSD.

Inland submission emits two individually checksum-protected commands, in order:

1. `AIVSD` with destination, ETA, status and the sum of all three personnel counts.
   If the total exceeds 8190, VSD uses 8191 (unavailable); individual Inland counts
   are still transmitted accurately.
2. `PIWWIVD` with crew/passengers/other in fields **7/8/9**. All other 10 fields
   are empty, leaving blue cones, reporting rate, loading, draught, air draught,
   tugboats and convoy extensions unchanged.

For example, 3 crew, 0 passengers, 0 other personnel produces:

```text
$PIWWIVD,,,,,,,3,0,0,,,,*5D
```

Reference: [CESNI Inland AIS Test Standard, Edition 2017/2.0](https://www.cesni.eu/wp-content/uploads/2017/07/CESNI_Test_Standard_Inland_AIS_en.pdf),
normative Annex C.1, printed page 37. It explicitly specifies that null fields
must not change the corresponding configuration.

The single **Send to AIS** button validates and submits both commands.
Internally, both commands must match server validation exactly; redistributing
the same total between crew and passengers changes that validation.
Commands are not an atomic transaction:
if the second emission fails, the first may already have changed the AIS.
An error reports the number of submitted commands; check the AIS before retrying.
Firmware acceptance must be verified on your AIS display.

### Blank fields clear values

Only navigational status must be entered. Blank editable values explicitly mean
**not available**, never "leave unchanged". Read-only ship type and draught still
come from Signal K and must be valid.

- Blank destination sends 20 `@` padding characters, the AIS unavailable destination.
- Blank ETA sends `246000.00,00,00`: unknown hour 24, minute 60, day/month 0.
  Midnight (`000000`) is not used as a substitute for unknown.
- Blank maritime persons sends `0` (unavailable).
- Blank Inland counts send the standard unknown sentinels: crew/other `255`,
  passengers `8191`. If any category is unknown, the VSD total is `8191`.
  Unrelated PIWWIVD fields remain empty and unchanged.

Blank destination/ETA and personnel explicitly clear those values. Check the AIS
display after testing clears: firmware acceptance has not been hardware-verified.
VSD field semantics are also described in the
[go-nmea VSD reference](https://github.com/adrianmo/go-nmea/blob/master/vsd.go).

**Inland personnel counts require incoming PIWWIVD readback**, not message 5 or
message 1/2/3. An Inland submission remains partial/waiting until its three counts
have arrived after submission. A matching PIWWIVD may be an echo and does not
prove that stored AIS settings changed.
No automatic retries or assumed zero Inland counts are used.

**Every submission is a real update of the complete VSD voyage data**, including
regional flags. Empty-field preservation is not assumed.

## Send and verify

1. Review the prefilled voyage fields and change only what needs updating.
   Missing readbacks stay blank; blanks clear values rather than preserve them.
2. Choose **Send to AIS** once. There is no preview or confirmation screen:
   this immediately submits real AIS commands after validation.
3. On the AIS display, check **Voyage Data**, including destination and status.

The button is disabled while sending to prevent duplicate clicks. The webapp
internally calls `/preview` for validation, then `/voyage`; the API contract is
unchanged. Editing during validation aborts submission. If Signal K ship
type/draught or plugin settings change between validation and submission,
the backend rejects the stale command. No
automatic updates, periodic transmissions or retries are performed.

HTTP 202 means **submitted to Signal K's serial output event**, not confirmed by
the AIS or guaranteed written to hardware. Signal K's event API supplies no AIS
acknowledgement or per-write completion callback; a registered listener can
exist even when the device is disconnected. Check server connection logs and the
AIS display. Diagnostics distinguish submissions from actual own-vessel reports.

## Diagnostics and logging

The bottom of the webapp has an **AIS diagnostics** section, collapsed by default.
Click its heading (or focus it and press Enter/Space) to expand or collapse it.
Automatic refresh continues while collapsed and does not change the open state.
The expanded section displays:

- **Last TX**: full VSD sentence and submission timestamp. CRLF is appended by
  Signal K's serial writer. This records submission, not hardware write completion.
- **Last related RX**: own-vessel report receive timestamp,
  including an indication when a multipart report is incomplete.
- **Last voyage report**: decoded destination, ship type, draught, UTC ETA and MMSI
  from the last complete own-vessel message 5.
- **Last navigation report**: own-vessel message 1, 2 or 3, decoded status
  and MMSI.
- **Last Inland personnel readback**: PIWWIVD receive timestamp and decoded crew,
  passengers and other personnel; unknown sentinels display as **Unknown**, and
  omitted counts as **Not included**.
- A per-field comparison against the latest submission, plus malformed-input
  errors. Refreshes every 10 seconds; **Refresh diagnostics** updates immediately.

The voyage form itself is prefilled from the latest received AIS readback where
available (destination, ETA, status and Inland personnel counts). This allows
editing only the fields that need changes, then sending. Prefill uses
received reports with Signal K destination/ETA fallback, and never overwrites fields
after manual edits.

Raw encoded RX payloads are omitted from the webapp, including receive error
messages. They remain available through the plugin API and server logs for
troubleshooting. The human-readable TX command is still shown.

### Route AIS readback

Signal K's global `nmea0183` event contains no source ID. To avoid mistaking
another connection's reports for your AIS, the plugin **does not** use that event.

Back up `settings.json` and stop Signal K before manual editing. Add:

```json
"sentenceEvent": "ais-voyage-in"
```

to **only the existing AIS connection's `options.subOptions`**, alongside its
`device` and `baudrate`. If `sentenceEvent` already exists, preserve it using an
array and add `"ais-voyage-in"`. Restart Signal K. Set the plugin's **AIS input
sentence event** to the same value. This works alongside `toStdout` and does not
alter the existing Signal K data conversion or global input stream.

The webapp remains usable for submission without this routing, but will show no
readback. Seeing output traffic alone is not proof that the RX route is configured.
Do not connect this input event to output or to another data connection.

Only checksum-valid **`!AIVDO`** own-vessel reports and **`$PIWWIVD`**
Inland personnel reports are decoded. **`!AIVDM`**
other-vessel traffic and outgoing/echoed VSD commands are not confirmation.
Multipart reports must arrive in order within 30 seconds; incomplete state is
bounded. All fragments must start after the latest submission to count as readback.
Reports received before a new submission remain visible, but do not count as
confirmation, even when they arrived in the same millisecond as the submission.

Status labels distinguish **submitted / no readback yet**, **partial readback**,
**different readback**, and **matching own-vessel readback**. A match requires
both message 5 and a navigation report for the same MMSI. Inland submissions also
require matching post-submission PIWWIVD crew, passengers and other counts.
Missing fields are not merged with previous reports and remain waiting.
PIWWIVD has no MMSI: its source is trusted only through the dedicated AIS input
route. It may be a serial echo, so it is readback evidence, not proof of storage.
No query or automatic retransmission is sent; if the AIS does not return
PIWWIVD, personnel rows remain waiting. Message 5 can take several minutes.
Explicit unknown destination/ETA/personnel values match their unknown readback
encodings; different values do not match.

Matching readback is **not a direct command acknowledgement**. Message 5 cannot
verify persons on board, regional flags, ETA year or ETA seconds; these are
explicitly excluded from comparison. Readback does not overwrite the form or
the Signal K data model.

Full submitted TX sentences and valid related RX fragments are written to the
**Signal K server log** with timestamps and event names, without needing debug
logging enabled. Invalid AIVDO/PIWWIVD input is logged as an error and shown in the panel.
No log file is created by the plugin: retention is controlled by the Signal K/GX
logging configuration. In-memory TX/RX diagnostics reset when the plugin stops,
its configuration changes, or the server restarts.

## API

Routes under `/plugins/signalk-write-ais-nmea0183` use Signal K's default
administrator authentication:

- `GET /state`: live vessel details, serial event registration, statuses and last
  submission, plus `diagnostics` (input event, last RX, decoded voyage/navigation
  reports, last receive error, comparison status and fields).
  `connection.available` means an advertised or explicitly configured
  route exists (and has a listener if the server exposes `listenerCount`), not
  hardware connectivity.
- `POST /preview`: JSON `{ destination, eta, navigationStatus, personsOnBoard }`.
  `eta` is UTC ISO format, for example `2026-11-15T12:00:00.000Z`.
  For Inland, replace `personsOnBoard` with
  `inlandPersonnel: { crew, passengers, other }`; do not provide both.
  Use `destination: ""`, `eta: null`, `personsOnBoard: null`, or null individual
  Inland counts to clear those values. Omitted/malformed fields remain errors.
  Returns `sentence` (VSD) and ordered `sentences` (VSD plus PIWWIVD for Inland).
- `POST /voyage`: the same fields plus `confirmedSentence` returned by preview.
  Inland requires `confirmedSentences`, the complete ordered array from preview.
  Returns 202 with `message`, `sentence`, voyage values and `submittedAt`.

Errors are explicit JSON with `error`: 400 invalid input, 403 cross-site write,
409 stale/unconfirmed preview, 422 invalid Signal K vessel data, 503 unavailable
plugin/output, 500 unexpected failure. No Signal K navigation values are
optimistically overwritten after emitting the command.

## Development and reference

No runtime dependencies or frontend build step. `npm test` uses Node's built-in
test runner; `npm run check` checks backend and frontend JavaScript syntax.

Protocol reference: Oceansat manual section **6.8.18**, VSD voyage data, printed
pages 69-70; accepted ports in section **6.1**, table 10, printed page 59.
Signal K integration follows its
[plugin API](https://github.com/SignalK/signalk-server/blob/master/docs/develop/plugins/README.md),
[webapp packaging](https://github.com/SignalK/signalk-server/blob/master/docs/develop/webapps.md)
and [serial provider](https://github.com/SignalK/signalk-server/blob/master/packages/streams/src/serialport.ts).
