# Changelog

## 0.1.14

- Add opt-in visual departure/arrival checklist reminders with a webapp link and review button.
- Add manual, on-send and automatic navigation.state modes with Auto-state source filtering.
- Send status-only VSD automatically without replacing other voyage settings.
- Use existing Signal K destination/ETA as form fallback before AIS voyage readback arrives.
- Show automatic status submissions separately in diagnostics; never publish requested settings as confirmed data.

## 0.1.13

- Publish releases through GitHub Actions with npm trusted publishing and provenance.
- Run Signal K's shared plugin CI on Linux x64/arm64, macOS and Windows.
- Add package metadata, MIT license, release instructions and changelog.
- Include matching icons at the package root and webapp serving root for App Store compatibility.

## 0.1.12

- Send voyage updates with one button, without a separate preview screen.
- Retain server-side validation, stale-command checks and duplicate-click protection.
- Include a standalone logo for the webapp, browser tab and Signal K Webapps list.
- Prepare public npm distribution and GitHub Actions CI/release workflows.

## 0.1.11

- Populate voyage form fields from own-vessel AIS readback when available.
- Remove the separate current-readback panel; keep detailed diagnostics collapsible.

## 0.1.10

- Add a boat and AIS signal logo.

## 0.1.9

- Rename the user-facing app to SignalK2AIS.
- Prefill voyage and Inland personnel fields without overwriting user edits.

## 0.1.8

- Display decoded current AIS readback.

## 0.1.7

- Display the running plugin version in the webapp and configuration.

## 0.1.6

- Decode incoming PIWWIVD personnel reports and default to Inland mode.

## 0.1.5

- Support clearing destination, ETA and personnel to unavailable values.

## 0.1.4

- Support Inland crew, passengers and other personnel with PIWWIVD.

## 0.1.3

- Simplify diagnostics and make them collapsible.

## 0.1.2

- Label the provider setting as Data Connection ID.

## 0.1.1

- Add own-vessel AIS readback, comparison diagnostics and serial-event logging.

## 0.1.0

- Initial manual voyage updates using an existing Signal K serial connection.
