# Changelog

## 0.1.0-beta.19

- Bind consent writes to the authenticated publisher session when a trusted session resolver is configured. A stale or different session is rejected before any consent write or preference-cookie change.

## 0.1.0-beta.18

- Prevent fractional clipping of the hosted ad frame at some device scales.
- Correct the consent language guidance: browser preference comes first, then the publisher fallback.

## 0.1.0-beta.17

- Optional `consentLocale` and `consentTheme` browser settings for the hosted consent dialog.
- Validate presentation settings before passing them to the renderer. Consent decisions, authorization and storage behavior are unchanged.
- Updated installation instructions and consent appearance reference.

## 0.1.0-beta.16

- Fixed diagnostic categories for renderer and observed CSP failures, without signed URLs or credentials.
- Optional placement positioning within the server-authorized formats, timing and size limits.
- Contain synchronous and asynchronous diagnostic callback failures.
- Expanded guidance for CSP, existing apps, session limits and separate secret ENV downloads.

## 0.1.0-beta.15

- Restore consent using the authoritative session revision after reload.

## 0.1.0-beta.14

- Reject wildcard origins during server configuration.
- Clarify complete Server ENV, required dependencies and integration into existing apps.

## 0.1.0-beta.13

- Shorter setup instructions with links to the API docs and Dashboard.
- Separate JavaScript, TypeScript and Python guides.
- Generation examples that preserve the app's request, response display and cancellation.
- Updated package description, documentation link and search keywords.

At `0.1.0-beta.13`, runtime code, exports and generator templates were unchanged from `0.1.0-beta.12`. Existing integrations remain on their selected version until explicitly upgraded.

The Python `0.1.0b9` source is included in the repository. Its released wheel is unchanged and is installed separately from npm.
