# @gladysassistant/integration-sdk

Official Node.js SDK to build **external integrations** for [Gladys Assistant](https://gladysassistant.com).

An external integration is a program running in an isolated Docker container, supervised by Gladys. It talks to
Gladys through the host API (REST) and an outgoing WebSocket — this SDK wraps both, so an integration usually fits in
a few dozen lines.

- Node.js >= 20, a single runtime dependency ([`ws`](https://github.com/websockets/ws))
- CommonJS + ESM, TypeScript typings included
- Automatic reconnection with exponential backoff, automatic state resynchronization, automatic command acks
- A fake Gladys for your unit tests: [`@gladysassistant/integration-sdk/testing`](#testing-your-integration)

## Getting started

The fastest way to start is the official template repository:
[`GladysAssistant/integration-template-js`](https://github.com/GladysAssistant/integration-template-js)
("Use this template" → edit the manifest → tag your repo with the `gladys-assistant-integration` topic → your
integration appears in the store of every Gladys). The complete developer documentation (manifest reference, host
API, container contract, publication guide) lives on
[gladysassistant.com](https://gladysassistant.com/docs).

## Install

```bash
npm install @gladysassistant/integration-sdk
```

## Usage

```js
import {
  GladysIntegration,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  logger,
} from '@gladysassistant/integration-sdk';
// CommonJS works too: const { GladysIntegration } = require('@gladysassistant/integration-sdk');
// (then wrap the `await` calls in an async function — CJS has no top-level await)

// Every option is read from the container env vars by default
// (GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR);
// override them for development outside Docker.
const gladys = new GladysIntegration();

gladys.onScanRequest(async () => {
  // External ids must be unique and stable per device: build them from an
  // identifier that comes from the brand/hardware (serial, MAC, Zigbee address…),
  // never from a generic word like "switch" alone.
  const ids = gladys.externalIds('switch', '0x00158d0001a2b3c4');
  await gladys.publishDiscoveredDevices([
    {
      name: 'Virtual switch',
      external_id: ids.device,
      features: [
        {
          name: 'On/Off',
          external_id: ids.feature('binary'),
          category: DEVICE_FEATURE_CATEGORIES.SWITCH,
          type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        },
      ],
    },
  ]);
});

gladys.onSetValue(async (device, feature, value) => {
  // resolving acks the command with success; throwing acks it as failed
  await gladys.publishState(feature.external_id, value);
});

gladys.onConfigUpdated(async (config) => {
  logger.info('New config', config); // stdout → docker logs, level set by LOG_LEVEL
});

gladys.handleShutdown(); // SIGTERM/SIGINT → clean disconnect → exit(0)

await gladys.connect(); // resolves once authenticated
```

## API

### `new GladysIntegration(options?)`

| Option       | Default                               | Description                     |
| ------------ | ------------------------------------- | ------------------------------- |
| `hostApiUrl` | `GLADYS_HOST_API_URL` env var         | Base URL of the Gladys host API |
| `token`      | `GLADYS_INTEGRATION_TOKEN` env var    | Integration JWT                 |
| `selector`   | `GLADYS_INTEGRATION_SELECTOR` env var | Integration selector            |

Throws immediately when a value is missing (neither option nor env var).

Advanced options: `reconnectBaseDelay` (default 1000 ms), `reconnectMaxDelay` (default 60000 ms),
`requestTimeout` (default 15000 ms — host API requests are aborted past this delay) and `logger` (the logger used
for the connection lifecycle logs, default `createLogger({ name: 'gladys-sdk' })` — pass
`createLogger({ level: 'silent' })` to silence the SDK entirely).

### Methods

All methods return Promises; host API errors are thrown as `GladysApiError { status, code, message }`.

| Method                                                       | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect()`                                                  | Opens the WebSocket, authenticates, resynchronizes (`GET /device` + `GET /config`), then resolves. Reconnects automatically for life with `min(1s * 2^n, 60s)` backoff; every reconnection re-authenticates and resynchronizes. A token refused by Gladys (close code 4000) keeps the loop armed but jumps straight to the max delay — the refusal may be transient, and the integration must never go zombie                                                                                                                                                |
| `disconnect()`                                               | Closes cleanly (no more reconnection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `externalId(suffix)`                                         | → `` `ext:${selector}:${suffix}` `` — the only documented way to build an `external_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `externalIds(type, platformId)`                              | → `{ device, feature(key) }` — the ids of ONE physical device. `platformId` must come from the external platform (serial, MAC, Zigbee address…) so the ids stay unique and stable                                                                                                                                                                                                                                                                                                                                                                            |
| `handleShutdown(cleanup?)`                                   | Exits gracefully on SIGTERM/SIGINT: runs the optional `(signal) => Promise` cleanup, disconnects cleanly, then `process.exit(0)`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `publishDiscoveredDevices(devices)`                          | Publishes the complete list of discovered devices (replaces the previous one). Re-publishing a device the user already created silently upserts its `params` and its features' `supported_options` in Gladys (a LAN IP that changed in DHCP, a camera preset renamed…) without touching its name/features and without a `device-updated` echo; a structure change (features) shows an "Update" button in the Discovery screen instead                                                                                                                        |
| `getHouses()`                                                | Houses configured in Gladys with their coordinates (`[{ id, name, selector, latitude, longitude }]`, sorted by name) — for integrations that own their own geo-dependent logic (water restrictions, pollen, air quality…). Requires `location: true` in the manifest (403 otherwise); `latitude`/`longitude` are `null` for an unlocated house, several houses may exist. Fetch at startup and on reconnection, there is no update event. A weather integration needs neither this nor `location: true`: the coordinates arrive in every `onWeatherGet` call |
| `getDevices()`                                               | Devices created by the user; also refreshes `gladys.devices`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `publishState(featureExternalId, value)`                     | `value` is a number, or `{ text }`, or `{ state, created_at }` for a past state                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `publishStates(states)`                                      | Batch (max 100 states per request)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `publishChangedStates(states, options?)`                     | Publishes only the states whose value changed since the last one published through it for the same feature (see [Publishing states efficiently](#publishing-states-efficiently)); splits batches above 100, re-sends what Gladys refused, `options.heartbeat` (ms) re-sends an unchanged value once that old. Resolves `{ success, count }`                                                                                                                                                                                                                  |
| `forgetPublishedStates(externalId?)`                         | Forgets the values remembered by `publishChangedStates` — one feature, one device (all its `<device>:<feature>` ids) or everything — so they are published again. Done automatically when the user creates, updates or deletes a device                                                                                                                                                                                                                                                                                                                      |
| `publishCameraImage(externalId, image)`                      | New image of a camera device (`image/jpg;base64,...`, ≤ 150 KB, 12 images/minute per device) — the dashboard camera widget updates in real time. Dedicated channel: images never go through `publishState`                                                                                                                                                                                                                                                                                                                                                   |
| `publishTransports(transports)`                              | Per-device transport status badge (`[{ external_id, transport: 'local' \| 'cloud' \| 'unreachable', degraded?, message? }]`, max 100 per request) — the lightweight path for live cloud/local switches, no need to re-publish the discovered devices. `degraded: true` + an optional multi-language `message` flag the "works, but not nominal" state (orange dot on the badge)                                                                                                                                                                              |
| `publishSceneEvent(key, data?)`                              | Fires a scene trigger declared in the manifest `scene_triggers`: something HAPPENED (plate recognized, object detected, doorbell pressed). `data` is flat — at most 30 keys, one primitive per key (string ≤ 1000 characters, finite number, boolean, null), validated before any request. The core matches it against the filters of the scenes and starts the matching ones; a resolved call means "accepted and evaluated once", never "a scene ran". 404 on an undeclared key, 429 past 300 events/minute per integration                                |
| `publishMessage(contactId, text, opts?)`                     | Communication integrations: a message received in the external channel. Gladys resolves the contact to the linked user and routes the message to the brain and the chat history; an unknown (not linked) contact is a 404 — answer "account not linked, code required" in the channel. `opts.createdAt` timestamps a message received offline. Bidirectional channels only: a send-only channel (`messaging.receive: false`) is a 403                                                                                                                        |
| `linkContact(code, contactId, name?)`                        | Communication integrations: link an external contact to the Gladys user who generated the code from the UI (single use, 15 min TTL). Resolves with the linked user (`{ selector, first_name, language }`); an invalid or expired code is a 404                                                                                                                                                                                                                                                                                                               |
| `getContacts()`                                              | Communication integrations: the linked contacts, each with its linked Gladys user                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `getCalendarAccounts()`                                      | Calendar integrations: the users who ENABLED the integration (`[{ user: { selector, first_name, language }, config }]`, their `account_schema` values, secrets included) — who to sync. Read it on every (re)connection and on `onCalendarAccountUpdated`; any other type is a 403                                                                                                                                                                                                                                                                           |
| `getCalendars(userSelector?)`                                | Calendar integrations: the calendars the integration pushed (`[{ user, external_id, selector, name, description, color, sync, shared }]`), with the user-owned `sync` flag telling which to skip; every user's when `userSelector` is omitted (the startup resync)                                                                                                                                                                                                                                                                                           |
| `publishCalendars(userSelector, calendars)`                  | Calendar integrations: upsert by `external_id` of ONE enabled user's calendars (`[{ external_id, name, description?, color? }]`, user-scoped ids `ext:<selector>:<user_selector>:<id>`); `name`/`description`/`color` are integration-owned (overwritten), `sync`/`shared`/`selector` user-owned (never touched). ≤ 50 per user, a not-enabled user is a 404, 30 calendar writes/minute per integration (429). Validated before any request                                                                                                                  |
| `deleteCalendar(externalId)`                                 | Calendar integrations: destroys one of the integration's calendars and its events (a provider-side deletion); another integration's or an unknown one is a 404                                                                                                                                                                                                                                                                                                                                                                                               |
| `publishCalendarEvents(calendarExternalId, events, window?)` | Calendar integrations: upsert by `external_id` (≤ 500 per call) of `[{ external_id, name, start, end?, full_day?, location?, description?, url? }]`; with `window: { from, to }`, the integration's events overlapping the window and absent from the list are pruned (one window, one request). A `sync: false` calendar is a 403, a disabled user's a 404. Validated before any request                                                                                                                                                                    |
| `publishEnergyCalendar(key, entries)`                        | Energy contracts: upsert by start of the entries of a tariff calendar declared in the manifest (`[{ starts_at \| date, value \| price, currency? }]`, ≤ 2,000 per call, 5 years back to 7 days ahead) — day colours, holidays, spot prices; an undeclared or foreign key is a 403. Resolves `{ success, count, changed_from }`; a changed value queues a bounded cost recalculation core-side. Validated before any request                                                                                                                                  |
| `getEnergyCalendar(key, options?)`                           | Energy contracts: reads back a declared and owned calendar (`[{ starts_at, value }]`, oldest first over `{ from, to }`, the `limit` last ones without a window) — resume after a restart                                                                                                                                                                                                                                                                                                                                                                     |
| `getEnergyContracts()`                                       | Energy contracts: the users' contracts referencing a template of the integration (`id`, `template_key`, `template_version`, `pricing_mode`, `inputs`, `valid_from`, `valid_to`, `timezone`, `currency`, `billing_period_start_day`, `status`) — never the meter nor the consumption                                                                                                                                                                                                                                                                          |
| `requestEnergyRecalculation()`                               | Energy contracts: fire-and-forget nudge — the core recomputes the recent costs (48 h) of the meters whose contract reads a calendar the integration declares. Rate-limited core-side (1/min per integration), ignored without a declared calendar, dropped silently while disconnected                                                                                                                                                                                                                                                                       |
| `publishEnergyConsumption(featureExternalId, intervals)`     | Energy: dated consumption of a supplier whose readings arrive after the fact, on a `thirty-minutes-consumption` or `daily-consumption` feature the integration feeds itself (`[{ starts_at \| date, kwh }]`, ≤ 2,000 per call, aligned on the Gladys clock, elapsed, ≤ 5 years old) — upserted by instant, never through `POST /state`. Resolves `{ success, count, changed_from }`; a changed value queues a bounded cost recalculation of the meter core-side. Device not created → 404 (retry once it exists). Validated before any request               |
| `requestWeatherRefresh()`                                    | Weather integrations: fire-and-forget freshness nudge — asks the core to re-pull the weather NOW (through `onWeatherGet`) and re-evaluate the weather-alert scene triggers, instead of waiting for the 30-minute scheduled check. Carries no data, expects no answer; rate-limited core-side (1/min per integration, silently dropped beyond), dropped silently while disconnected                                                                                                                                                                           |
| `requestWidgetRefresh(key)`                                  | Dashboard widgets: fire-and-forget freshness nudge for ONE widget — the core drops its cached content and every open instance re-pulls it through `onWidgetGet`, instead of waiting for the content `ttl_seconds`. Carries no data; rate-limited core-side (1 per 10 s per widget, silently dropped beyond), dropped silently while disconnected. Live device-bound tiles and charts need no nudge                                                                                                                                                           |
| `getWebhooks()`                                              | Gladys Plus webhook state: `{ available, webhooks: [{ key, mode, url }] }` — the ready-to-register public URL of each webhook declared in the manifest. `available: false` (no Gladys Plus linked) → degrade to poll only                                                                                                                                                                                                                                                                                                                                    |
| `getConfig()` / `setConfig(partialConfig)`                   | Configuration values; `getConfig` also refreshes `gladys.config`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `getStatus()`                                                | Gladys version + integration service status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `setConnectionStatus(connected, message?)`                   | Application-level connection status shown in the Configuration screen (`message` is an optional multi-language object, e.g. `{ en: 'Token expired' }`). Distinct from the container state machine: a cloud integration can be RUNNING and still disconnected from its third-party service                                                                                                                                                                                                                                                                    |
| `getContainers()`                                            | Sub-containers declared in the manifest: Docker status, desired state, published ports (`{ container_port, protocol, host_port, label, name, browsable }`, `host_port: null` while none is assigned yet), granted/available hardware classes                                                                                                                                                                                                                                                                                                                 |
| `startContainer(name, { env }?)`                             | Creates (if needed) and starts a declared sub-container — typically after generating its config files in `/data`; `env` carries runtime-computed values (secrets never go through the public manifest)                                                                                                                                                                                                                                                                                                                                                       |
| `stopContainer(name)`                                        | Stops a sub-container; the supervisor will not restart it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `restartContainer(name)`                                     | Restarts a sub-container, e.g. after rewriting its config through `/data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scanNetwork(type, options?)`                                | On-demand mediated network scan of a capture declared in the manifest `network_discovery` field (`udp-broadcast` \| `udp-active-broadcast` \| `mdns` \| `ssdp`); returns the RAW results — parsing them is the integration's job (`parseMdnsTxt` turns the raw mDNS TXT entries into an object). `udp-active-broadcast` (query/response, TP-Link Kasa style) additionally takes `{ port, payload }`: the integration forges the request, the core broadcasts it and relays the raw unicast replies                                                           |
| `wakeOnLan(mac, options?)`                                   | Sends a standard Wake-on-LAN magic packet from the Gladys core network namespace (bridge containers cannot reach the LAN in broadcast). Requires `network_wake: true` in the manifest (403 otherwise); the core builds the fixed magic packet itself (never integration-provided bytes) and bounds the rate to 1 wake per 2 s per integration (429 beyond). Options: `{ address, port, sourcePort }`                                                                                                                                                         |

### Handlers

Register handlers before `connect()`. Commands are acked automatically: the handler resolves →
`command-result success:true` — and when the resolved value is not `undefined`, it is sent back in `data` (for
commands that expect an answer) —, it throws → `success:false` with the error message, no handler registered →
`success:false "not implemented"`.

| Handler                                                               | Callback signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSetValue(cb)`                                                      | `(device, deviceFeature, value) => Promise` — `value` is a number, except on the `text` category features whose commands are strings (the free text of `text`/`text`, the selected option value of a `text`/`select` dynamic select)                                                                                                                                                                                                                                                                                                                                                                |
| `onPoll(cb)`                                                          | `(device) => Promise` — respond by publishing states. Only the devices published with `should_poll: true` and a `poll_frequency` **in milliseconds** among `DEVICE_POLL_FREQUENCIES` are polled (see [Polling devices](#polling-devices))                                                                                                                                                                                                                                                                                                                                                           |
| `onGetImage(cb)`                                                      | `(device) => Promise<string>` — capture and resolve a FRESH camera image (`image/jpg;base64,...`, ≤ 150 KB); acked back as `data.image`, awaited under 15 s (not 5 s) so an ffmpeg-style capture fits                                                                                                                                                                                                                                                                                                                                                                                               |
| `onScanRequest(cb)`                                                   | `() => Promise` — respond through `publishDiscoveredDevices`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `onDeviceCreated(cb)` / `onDeviceUpdated(cb)` / `onDeviceDeleted(cb)` | `(device) => Promise`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `onConfigUpdated(cb)`                                                 | `(config) => Promise` — complete new values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `onHardwareUpdated(cb)`                                               | `(containers) => Promise` — the hardware grants changed: regenerate the affected configs, then `startContainer`/`restartContainer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `onOAuthAuthorizeUrl(cb)`                                             | `(key, redirectUri) => Promise<string>` — build the provider authorization URL (client_id from the config, scopes, a `state` you generate and remember). Also called for an `account_link` field (a provider that never redirects back), with `redirectUri` undefined and no callback to expect                                                                                                                                                                                                                                                                                                     |
| `onOAuthCallback(cb)`                                                 | `(key, { code, state, redirectUri }) => Promise` — verify `state`, exchange the tokens, store them via `setConfig`, then `setConnectionStatus(true)`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `onAction(key, cb)`                                                   | `(fields) => Promise<string \| object>` — handler of ONE action declared in the manifest, registered per `key`; `fields` are validated by the core, the declared `default` of every field left empty applied; the resolved message is shown under the button (ack awaited under the action's `timeout_seconds`, not 5 s)                                                                                                                                                                                                                                                                            |
| `onSendMessage(cb)`                                                   | `(contact, message) => Promise` — communication integrations: deliver `message` (`{ text, file }`) in the external channel. `contact` is the identity resolved by Gladys: `{ id }` for a channel linked by code (`messaging.receive: true`), or the target user's `contact_schema` values for a send-only channel (`receive: false`)                                                                                                                                                                                                                                                                |
| `onWeatherGet(cb)`                                                    | `(options) => Promise<object>` — weather integrations (manifest `type: "weather"`): `options = { latitude, longitude, language, units }`; resolve the pivot weather format with values in the requested unit system (`'metric'` or `'us'`), it is acked back as `data.weather` (awaited under 15 s, not 5 s, so a fresh third-party API call fits)                                                                                                                                                                                                                                                  |
| `onWeatherGetImage(cb)`                                               | `(key) => Promise<string>` — weather integrations: resolve the RAW base64 (no `data:` URI prefix) of a provider image declared in the pivot's `images` metadata (vigilance map, rain radar…); PNG or JPEG, ≤ 500 KB decoded, acked back as `data.image` (awaited under 15 s), validated and cached 10 minutes by the core                                                                                                                                                                                                                                                                           |
| `onWebhook(key, cb)`                                                  | `({ method, query, body, contentType }) => Promise` — handler of ONE webhook declared in the manifest, registered per `key`. `fire_and_forget`: the resolved value is ignored; `sync`: resolve `{ status?, contentType?, body? }` and it is returned to the third party through Gladys Plus                                                                                                                                                                                                                                                                                                         |
| `onSceneAction(key, cb)`                                              | `(fields) => Promise<object \| void>` — handler of ONE scene action declared in the manifest `scene_actions`, registered per `key`, run when a scene reaches it; `fields` are the RESOLVED values (scene variables substituted, defaults applied, validated by the core). Resolve an object of the declared `outputs` (scalars only) for the following actions of the scene, or `undefined`; throwing fails that action only, the scene continues. Ack awaited under the action's `timeout_seconds` (default 30 s)                                                                                  |
| `onWidgetGet(key, cb)`                                                | `({ settings, language, units }) => Promise<content>` — handler of ONE dashboard widget declared in the manifest `widgets`, registered per `key`: resolve the content `{ version?, ttl_seconds?, components }` in the core vocabulary, localized from `language` and `units`; acked back as `data.content` (awaited under 15 s), normalized and trimmed to the content budget by the core                                                                                                                                                                                                           |
| `onWidgetGetImage(cb)`                                                | `(imageKey) => Promise<string>` — dashboard widgets: resolve the RAW base64 (no `data:` URI prefix) of an image key declared in a content; PNG, JPEG or WebP, ≤ 300 KB decoded, ≤ 4096 × 4096 px, cached one hour by key (a changing image needs a changing key). One handler for all keys, awaited under 15 s                                                                                                                                                                                                                                                                                      |
| `onWidgetAction(key, cb)`                                             | `(actionKey, params, { settings, values }) => Promise<string \| object \| void>` — dashboard widgets: the user tapped a `button` carrying an `action` in the widget's content; `params` are the ones declared in that content (never user input), `values` the form of a button declaring `fields`, validated by the core (absent otherwise). Resolve an optional toast message (string, multi-language object or `{ message }`, ≤ 200 characters); the core then drops the cached content so every open instance refetches. Ack awaited under the widget's `action_timeout_seconds` (default 30 s) |
| `onWebhookUpdated(cb)`                                                | `({ available, webhooks }) => Promise` — the Gladys Plus webhook availability changed (Plus linked/unlinked, key changed): re-register the fresh URLs at the third party, or degrade to poll only                                                                                                                                                                                                                                                                                                                                                                                                   |
| `onCalendarAccountUpdated(cb)`                                        | `(userSelector) => Promise` — calendar integrations (manifest `type: "calendar"`): a user enabled or disabled the integration, changed their account values or toggled a calendar's `sync`/`shared`, the change already applied; re-read `getCalendarAccounts()` / `getCalendars(userSelector)` and adjust the sync loops (no ack, lost while disconnected — re-read both on every connection)                                                                                                                                                                                                      |
| `onEnergyPrice(cb)`                                                   | `({ contract, billing_period, cumulative_before, intervals }) => Promise<costs>` — energy contracts, delegated pricing: price the half-hour intervals of ONE billing period (≤ 1,488); resolve one `{ starts_at, cost, components?, label? }` per interval, acked back as `data.costs` (awaited under 30 s). Deterministic: a retry carries the same state                                                                                                                                                                                                                                          |
| `onEnergyCurrent(cb)`                                                 | `({ contract, billing_period, cumulative, max_power_kw }) => Promise<{ price, valid_until?, next_price?, label?, next_label? }>` — energy contracts, delegated pricing: the current price per kWh and when it changes, acked back as `data` (awaited under 5 s) for the dashboard price widget and the "current price" scene condition                                                                                                                                                                                                                                                              |

### Manifest actions

For on-demand operations with a visible result — connection test, identify, re-pairing, protocol detection… —
declare `actions` in the manifest: each one is rendered as a button (with an optional mini-form, `fields`) in the
Configuration screen. The Tuya-style example: detect the protocol version of a device whose IP was typed by hand
because the UDP scan did not find it — a long operation, hence the per-action `timeout_seconds` (5–120 s, default 30) replacing the standard 5 s ack delay:

```json
"actions": [
  {
    "key": "detect_protocol",
    "label": { "en": "Detect protocol version", "fr": "Détecter la version de protocole" },
    "timeout_seconds": 30,
    "fields": [
      { "key": "ip", "type": "string", "label": { "en": "Device IP" }, "required": true }
    ]
  }
]
```

```js
gladys.onAction('detect_protocol', async (fields) => {
  const version = await tryProtocolVersions(fields.ip); // your protocol code, can take ~15 s
  return { en: `Protocol ${version} detected`, fr: `Protocole ${version} détecté` };
});
```

The resolved value — a string or a multi-language object — is displayed under the button; throwing displays the
error message instead.

#### Acting on a specific device or house: dynamic selects (`source: "devices"` / `"houses"`)

A `select`/`multi_select` field — in an action's `fields`, in the manifest `config_schema`, in a scene
declaration, a widget's `settings` or a calendar `account_schema` — can replace its static `options` with
`"source"`, a core-defined enum (never a URL nor an expression). Two values:

- **`"devices"`**: the Configuration screen populates the options with the **integration's own created devices**
  (label = device name, value = `external_id`). This is the answer to "act on THIS device" without asking the user
  to copy an identifier — the handler receives the chosen `external_id` like any other field value.
- **`"houses"`**: the options are the **houses of Gladys** (label = house name, value = the house `selector`, the
  identifier `getHouses()` returns) — for an integration serving one house of the instance. Picking a house needs
  no `location: true`: only the chosen selector reaches the integration, and reading the houses themselves (with
  their coordinates) stays the `location` contract of `getHouses()`. Consequently, without `location: true`,
  `setConfig` only takes a `houses` field back unchanged (a no-op): any other value is a 403 — the house is the
  user's choice. Requires a Gladys that knows the source (check the `gladys_version` range of your manifest).

Declaring `source` and `options` together, or an unknown `source` value, rejects the manifest.

```json
"actions": [
  {
    "key": "identify",
    "label": { "en": "Identify device", "fr": "Identifier l'appareil" },
    "fields": [
      { "key": "device", "type": "select", "source": "devices", "label": { "en": "Device", "fr": "Appareil" }, "required": true }
    ]
  }
]
```

```js
gladys.onAction('identify', async (fields) => {
  await blinkDevice(fields.device); // fields.device is the chosen device external_id
  return { en: 'Device identified', fr: 'Appareil identifié' };
});
```

### Onboarding guidance: `section` intro blocks and the Documentation link

A generated form is compact, but it gives no room for onboarding guidance — the Netatmo-style case: in front of
"Client ID", the user must first know they have to create an app on the manufacturer's developer platform. Declare
fields of type **`section`** in the manifest `config_schema` (and in an action's `fields`, which share the format):
purely presentational intro blocks that split the form into chapters. Since `config_schema` is an ordered list,
sections naturally structure large forms.

```json
"config_schema": [
  {
    "key": "intro",
    "type": "section",
    "label": { "en": "Getting started", "fr": "Pour commencer" },
    "description": { "en": "Create a developer account to get your API key.", "fr": "Créez un compte développeur pour obtenir votre clé d'API." },
    "links": [ { "url": "https://open-meteo.com/en/docs", "label": { "en": "Open-Meteo docs", "fr": "Doc Open-Meteo" } } ]
  },
  { "key": "api_key", "type": "secret", "label": { "en": "API key" }, "required": true }
]
```

A `section` carries a `label` (multi-language, `en` mandatory — the chapter title), a plain-text `description`
(multi-language, ≤ 1000 characters per language) and optional `links` (≤ 5 entries `[{ url, label }]`, **https
mandatory**). The core renders a visual separator + text + links opened in a new tab with the **target domain
displayed** next to the label — no markdown, no HTML (declarative UI principle). Declaring `required`, `default` or
`placeholder` on a section, or a non-https `url`, rejects the manifest.

A section stores **no value**: its key never appears in `gladys.config`, `getConfig()`, `onConfigUpdated` values or
an action handler's `fields`, and sending it through `setConfig` is rejected by the host API.

#### Placeholders in section texts: `{{gladys_host}}` and `{{port:<name>}}`

Some integrations have to show the user a URL pointing **at Gladys itself** — the OCPP case: "configure your charge
point to `ws://<gladys>:<port>`". The server cannot build that address reliably (it does not know which LAN address
the user reaches Gladys by: several interfaces, reverse proxy, VPN), but the **browser knows it by construction**.
So the `label` and `description` of a `section` may embed two plain-text tokens, substituted by the Gladys frontend
at render time — exact syntax, no space inside the braces, no expression and no injected code (declarative UI
principle):

| Token             | Substituted with                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `{{gladys_host}}` | The hostname of the address the browser currently uses to reach Gladys                            |
| `{{port:<name>}}` | The host port Gladys assigned to the declared sub-container port carrying that `name` (see below) |

```json
"containers": [
  {
    "name": "ocpp",
    "docker_image": "ghcr.io/acme/ocpp:1.2.0",
    "ports": [{ "container_port": 9000, "name": "ocpp", "label": { "en": "OCPP endpoint" }, "browsable": false }]
  }
],
"config_schema": [
  {
    "key": "charge_point",
    "type": "section",
    "label": { "en": "Connect your charge point" },
    "description": {
      "en": "Point your charge point to ws://{{gladys_host}}:{{port:ocpp}}/",
      "fr": "Pointez votre borne vers ws://{{gladys_host}}:{{port:ocpp}}/"
    }
  }
]
```

Rules to know when writing the manifest:

- a `{{port:<name>}}` that references a name declared **nowhere** in the manifest **rejects the manifest** (indexer
  and server, like any structural error) — an unknown reference would sit unresolved on screen forever;
- `{{gladys_host}}` works in every section the engine renders (`config_schema`, action `fields`, `contact_schema`),
  since the browser resolves it whatever the user's role; `{{port:<name>}}` is **refused in `contact_schema`**: that
  per-user block is the one screen a non-admin reaches, and their reduced view carries no container state, so the
  token would resolve for an admin and stay raw for everyone else;
- a valid `{{port:<name>}}` whose port has **no assigned host port yet** (sub-container never started) is left
  **as-is** on screen — honest and debuggable, it resolves the next time the screen is loaded after the allocation.
  Start the sub-container that publishes the port before pointing the user at the sentence;
- browsing through Gladys Plus or a reverse proxy, `{{gladys_host}}` resolves to the tunnel/proxy hostname, not to
  the instance's LAN address — if the device must reach Gladys over the LAN, say so in the repo documentation.

For the long step-by-step (screenshots…), the right medium stays the mandatory repo documentation
(`docs/en.md` + `docs/fr.md`): the Configuration screen now shows a permanent **"Documentation"** link to it
(re-hosted, user language with `en` fallback) — it is when configuring that the user needs it most.

### OAuth2 cloud services

For cloud services that need a browser authorization (Netatmo-style), declare a field of type `oauth2` in the
manifest `config_schema`: the Configuration screen renders a "Connect" button, and Gladys relays the whole flow to
the integration — the Gladys server knows no provider.

```js
let state;

gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
  // Build the URL yourself: client_id from your config, your scopes, and an
  // anti-CSRF `state` you generate and remember for the callback.
  state = crypto.randomUUID();
  return `https://api.netatmo.com/oauth2/authorize?client_id=${gladys.config.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read_station&state=${state}`;
});

gladys.onOAuthCallback(async (key, { code, state: returnedState, redirectUri }) => {
  if (returnedState !== state) throw new Error('state mismatch');
  const tokens = await exchangeCodeForTokens(code, redirectUri); // your provider call
  // Store the tokens as config keys OUTSIDE the config_schema: free internal
  // storage, never shown in the UI, never sent through the front.
  await gladys.setConfig({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  await gladys.setConnectionStatus(true);
});
```

Token refresh stays the integration's job; when the token expires beyond repair, report it so the user sees it in
the UI instead of a silently broken integration:

```js
await gladys.setConnectionStatus(false, { en: 'Token expired, please reconnect.', fr: 'Token expiré.' });
```

Some providers link an account **without ever redirecting back** to Gladys — a QR sign-in approved in the vendor
app (Xiaomi Home style), a pairing confirmed on a device. Declare the field as `account_link` instead of `oauth2`:
the Configuration screen renders the same "Connect" button and `onOAuthAuthorizeUrl` is called the same way, but
`redirectUri` is `undefined` (there is none), no anti-CSRF `state` is needed (there is no round trip to protect)
and `onOAuthCallback` is never called. Return the provider sign-in URL, watch for the approval yourself (long-poll
the provider), then report it through `setConnectionStatus(true)` — that is what drives the connection badge.

### Incoming webhooks through Gladys Plus

Some cloud services push their events by webhook (Netatmo-style: a setpoint change arrives in ~2-3 s instead of the
next poll) — but a local Gladys is not reachable from the Internet. Declare the webhooks in the manifest (≤ 3
entries) and **Gladys Plus relays them** to the integration, without knowing anything about it:

```json
"webhooks": [
  { "key": "events", "label": { "en": "Netatmo events" }, "mode": "fire_and_forget" },
  { "key": "callback", "label": { "en": "Subscription callback" }, "mode": "sync" }
]
```

The user pastes their Gladys Plus Open API key in the "Gladys Plus webhooks" block of the Configuration screen
(rendered by the core when the manifest declares `webhooks`), and Gladys builds the public URLs. The integration
registers them at the third party — the Netatmo pattern: re-register on every successful connection, best effort:

```js
const registerWebhooks = async () => {
  const { available, webhooks } = await gladys.getWebhooks();
  if (!available) return; // no Gladys Plus linked: poll only
  const events = webhooks.find((w) => w.key === 'events');
  await thirdPartyApi.addWebhook(events.url); // your provider call
};

gladys.on('connected', registerWebhooks);
gladys.onWebhookUpdated(registerWebhooks); // Plus linked/unlinked, key changed

gladys.onWebhook('events', async ({ body }) => {
  // Doctrine "trigger, not data": events arrive duplicated, late or out of
  // order, and their payloads are partial — use them to TRIGGER a refresh
  // through the manufacturer API, never apply the payload as a state. That is
  // also what makes lost events painless: the poll stays the source of truth.
  await refreshFromApi();
});
```

Two modes, matching what exists in the field. **`fire_and_forget`** (default, the Netatmo-style event stream): the
third party only awaits an acknowledgment — Gladys answers immediately and relays asynchronously; the handler's
resolved value is ignored and its errors are swallowed. **`sync`** (challenge/response registrations,
Strava/Microsoft Graph style): the caller awaits the integration response — resolve with
`{ status?, contentType?, body? }` (status 200-499, body ≤ 64 KB) and it is returned verbatim to the third party;
resolving `undefined` or throwing lets Gladys answer its default empty `200`:

```js
gladys.onWebhook('callback', async ({ query }) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ 'hub.challenge': query['hub.challenge'] }),
}));
```

Security, stated honestly: the URL **is** the secret (payloads are not authenticated — verifying the provider
signature, when one exists, is the integration's job), and requires a Gladys with webhook-relay support (check the
`gladys_version` range of your manifest).

### Communication channels

Messaging channels are integrations of manifest `type: "communication"`: no Devices/Discovery screens, and the
integration exchanges messages through the host API. The manifest declares which of the **two families** the
channel belongs to — sending is always present, receiving is not:

```json
"messaging": { "receive": true }
```

- **Bidirectional chat channels** (`receive: true` — Telegram-like bots: Matrix, Signal, WhatsApp…): the user
  links their account by code from the Configuration screen, then speaks to the brain from the channel.
- **Send-only notification channels** (`receive: false` — Free Mobile SMS, CallMeBot…): no incoming path exists.
  Each user enters their own credentials in the "My account" block of the Configuration screen, described by the
  manifest **`contact_schema`** (same flat format as `config_schema`); Gladys passes them to the integration with
  every outgoing message. No linking code — there is no channel to send it through, and no user authority to
  protect (the `403` on `publishMessage` guarantees a notification channel never talks to the brain).

The identity handling follows: `onSendMessage(contact, message)` receives the identity **resolved by Gladys** —
`{ id }` (the linked contact id) for a bidirectional channel, or the target user's `contact_schema` values for a
send-only one. Users without a linked account or configured credentials are skipped by Gladys and never reach the
handler.

A send-only channel is just the outgoing block (the Free Mobile-style case):

```json
"messaging": { "receive": false },
"contact_schema": [
  { "key": "username", "type": "string", "label": { "en": "Free Mobile login" }, "required": true },
  { "key": "access_token", "type": "secret", "label": { "en": "SMS API key" }, "required": true }
]
```

```js
gladys.onSendMessage(async (contact, message) => {
  // contact = the target user's contact_schema values.
  await sendFreeMobileSms(contact.username, contact.access_token, message.text);
});
```

A bidirectional channel adds the linking and incoming blocks:

- **Linking** — the consent step. The user clicks "Link my account" in the Gladys UI, which shows a short code
  (single use, 15 minutes TTL); they send it to the bot in the external channel, and the integration relays it
  with `linkContact(code, contactId, contactName?)`. From then on the contact speaks with the authority of the
  linked user (trigger scenes, ask about the house…) — which is exactly why the code flow exists. The user can
  revoke the link from the same screen at any time.
- **Incoming** — `publishMessage(contactId, text)`: Gladys resolves the contact to the linked user and routes the
  message to the brain and the chat history; the reply comes back through `onSendMessage`. An unknown contact is
  rejected with a 404: catch it and answer "account not linked" with the linking instructions.

```js
gladys.onSendMessage(async (contact, message) => {
  await bot.sendMessage(contact.id, message.text); // message.file: attached image (base64) or null
});

bot.on('message', async (chatId, text) => {
  if (looksLikeLinkCode(text)) {
    const user = await gladys.linkContact(text.trim(), chatId, await bot.getChatName(chatId));
    await bot.sendMessage(chatId, `Linked to ${user.first_name}!`);
    return;
  }
  try {
    await gladys.publishMessage(chatId, text);
  } catch (e) {
    if (e.status === 404) {
      await bot.sendMessage(chatId, 'Account not linked: get a code from the Gladys UI and send it to me.');
    } else {
      throw e;
    }
  }
});
```

Texts are limited to 4096 characters. `getContacts()` lists the linked contacts (with their linked Gladys user),
e.g. to resynchronize the channel-side state after a restart. Requires a Gladys with communication-integrations
support (check the `gladys_version` range of your manifest).

### Weather providers

Weather providers (Météo France, Open-Meteo, AccuWeather…) are integrations of manifest `type: "weather"`: no
Devices/Discovery screens (like communication channels), no devices and no states — a **dedicated provider API**.
The integration answers the core's weather requests, and Gladys feeds the dashboard weather widget and the chat
assistant with them. Installing a weather integration takes precedence over the built-in OpenWeather service with
zero configuration; stopping or uninstalling it falls back automatically.

Everything goes through one handler:

```js
gladys.onWeatherGet(async ({ latitude, longitude, language, units }) => {
  const data = await fetchProviderForecast(latitude, longitude, language, units); // your provider code
  return {
    // Required: temperature, weather (condition), datetime.
    temperature: data.current.temperature,
    weather: WEATHER_CONDITIONS.RAIN,
    datetime: new Date().toISOString(),
    // Optional current fields, dropped when your provider lacks them:
    apparent_temperature: data.current.feelsLike,
    humidity: 80, // percentages are 0-100
    wind_speed: 4.2,
    uv_index: 3,
    sunrise: data.current.sunrise,
    sunset: data.current.sunset,
    is_day: data.current.isDay, // strict boolean; drives the day/night icon variant
    // Forecasts (≤ 24 hours, ≤ 8 days kept by Gladys):
    hours: data.hours.map((h) => ({ temperature: h.temp, weather: toCondition(h), datetime: h.time })),
    days: data.days.map((d) => ({ temperature_min: d.min, temperature_max: d.max, datetime: d.date })),
    // CAP-style alerts (≤ 10; Météo France vigilance: yellow → moderate, orange → severe, red → extreme):
    alerts: [
      { severity: WEATHER_ALERT_SEVERITIES.SEVERE, event: 'Orages violents', type: WEATHER_ALERT_TYPES.THUNDERSTORM },
    ],
  };
});
```

The contract, point by point:

- **`units` is the requesting user's preference** — `'metric'` (°C, m/s, hPa, mm, km) or `'us'` (°F, mph, in,
  mi): return values in that unit system. Percentages (`humidity`, `cloud_cover`, `precipitation_probability`)
  are always 0-100, never fractional.
- **`weather` is a condition of the pivot enum** (`WEATHER_CONDITIONS`): `clear` | `partly-cloudy` | `cloud` |
  `fog` | `drizzle` | `rain` | `pouring` | `sleet` | `hail` | `snow` | `thunderstorm` | `wind` | `night` |
  `unknown` — map your provider's codes to it; anything else is coerced to `unknown` by the core (neutral icon).
- **`is_day` carries the day/night signal** (optional strict boolean on the current conditions and each `hours`
  entry — anything else is dropped, never coerced; absent → rendered as day): `weather` keeps the meteorology,
  `is_day` drives the day/night rendering variant. The `night` condition stays accepted for compatibility but is
  **deprecated for providers** — a rainy night is `weather: 'rain', is_day: false`, not `'night'`.
- **Alerts can carry a phenomenon `type`** (`WEATHER_ALERT_TYPES`): `wind` | `rain` | `flood` | `thunderstorm` |
  `snow` | `heat` | `cold` | `avalanche` | `coastal` | `fog` — so the core can translate and iconify the alert
  where the free-text `event` cannot. Optional metadata: an invalid `type` is dropped by the core, the alert is
  kept and rendered from its `event` text alone.
- **The ack is awaited under 15 s** (not the standard 5 s), so a fresh third-party API call fits. Throwing —
  provider not configured, API down — acks the command as failed, and the Gladys provider loop falls through to
  the next available provider.
- **The payload is normalized and bounded by the core**: unknown fields are dropped, numbers must be finite,
  dates must parse, arrays are capped (24 `hours`, 8 `days`, 10 `alerts`, 3 `images`), alert strings are
  truncated (`event` ≤ 100 characters, `description` ≤ 5000 — CAP descriptions run long). `days` may or may not
  include the current day — consumers filter by calendar date, a provider never has to lead with today.

Two optional extensions complete the type:

- **Provider images** (vigilance map, rain radar, satellite view…) — the payload only ever declares **metadata**:
  `images` (≤ 3 entries of `{ key, label? }`, `key` matching `^[a-z0-9][a-z0-9-]{0,31}$`, `label` a
  multi-language object with values ≤ 50 characters). The bytes travel **on demand** through `onWeatherGetImage`:
  resolve the RAW base64 (no `data:` URI prefix) of a PNG or JPEG of at most 500 KB decoded — the core checks the
  magic numbers and the size, caches the validated image 10 minutes per key, and serves it to the browser from
  its own origin (the browser never loads a third-party URL).

  ```js
  gladys.onWeatherGetImage(async (key) => {
    const png = await fetchVigilanceMap(); // your provider code, returns a Buffer
    return png.toString('base64');
  });
  ```

- **The freshness nudge** — Gladys evaluates its weather-alert scene triggers on a 30-minute scheduled check
  (pulled through `onWeatherGet`, diffed on the normalized alerts). A provider that KNOWS something changed
  upstream can do better — never by pushing data: `requestWeatherRefresh()` only means "re-pull me now". The
  data re-enters through the audited `onWeatherGet` path; the nudge itself carries nothing (fire-and-forget,
  rate-limited core-side to 1/min per integration, silently dropped beyond). The Météo France pattern: poll the
  vigilance upstream, nudge on change — the scene fires seconds later instead of within 30 minutes.

  ```js
  onUpstreamVigilanceChange(() => gladys.requestWeatherRefresh());
  ```

Requires a Gladys with weather-integrations support (check the `gladys_version` range of your manifest).

### Calendar providers

A calendar provider — Google Calendar, Outlook, a CalDAV server, a public ICS feed (school timetable, waste
collection) — is an external integration of type `"calendar"`: **the integration syncs, the core stores**. The
calendars and events it pushes feed the calendar view, the `calendar.event-is-coming` scene trigger, the
calendar scene actions and the assistant exactly like the internal CalDAV ones; Gladys never writes back to the
provider. No Devices/Discovery screens: the page shows every user a **"My calendars"** block — the optional
`account_schema` fields (the same flat format as the `config_schema`, per-user values, no `oauth2`/`account_link`
in v1) and an Enable action. **Enabling is the consent**: calendars are personal data, so the integration only
syncs the users who enabled it, each one owning their calendars, with a `sync` toggle (skip it) and a `shared`
toggle (visible to the household — and only then to the scenes).

```json
{
  "type": "calendar",
  "account_schema": [
    { "key": "server_url", "type": "string", "label": { "en": "Server URL" }, "required": true },
    { "key": "app_password", "type": "secret", "label": { "en": "App password" }, "required": true }
  ]
}
```

```js
// Who to sync: the enabled users, with their account values (secrets included).
// Read on every connection and on account-updated; set a sync loop per user.
const syncUser = async ({ user, config }) => {
  const client = await caldav.connect(config.server_url, config.app_password); // your provider code
  // Every id is USER-SCOPED (ext:<selector>:<user_selector>:<provider id>): two
  // users syncing the same provider-side id never collide.
  const calendarId = (id) => gladys.externalId(`${user.selector}:${id}`);
  await gladys.publishCalendars(
    user.selector,
    (await client.calendars()).map((c) => ({ external_id: calendarId(c.url), name: c.name, color: c.color })),
  );
  const skipped = new Set((await gladys.getCalendars(user.selector)).filter((c) => !c.sync).map((c) => c.external_id));
  for (const calendar of await client.calendars()) {
    if (skipped.has(calendarId(calendar.url))) continue; // the user said no: the core would answer 403
    // A window REPLACES its content: the events of the provider absent from the
    // list are pruned (a provider-side deletion propagates by republishing).
    const window = { from: startOfMonth, to: addMonths(startOfMonth, 12) };
    await gladys.publishCalendarEvents(
      calendarId(calendar.url),
      (await client.events(calendar, window)).map((e) => ({
        external_id: calendarId(e.uid + (e.recurrenceId || '')), // recurrences are expanded by the integration
        name: e.summary,
        start: e.start, // '2026-08-14T09:00:00.000Z', or '2026-08-15' on a full-day event
        end: e.end, // exclusive on a full-day event (the iCalendar convention)
        full_day: e.allDay,
        location: e.location,
        url: e.url,
      })),
      window,
    );
  }
};

gladys.on('connected', async () => {
  for (const account of await gladys.getCalendarAccounts()) await syncUser(account);
});
gladys.onCalendarAccountUpdated(async (userSelector) => {
  // enabled, disabled (their calendars are already destroyed), values changed or a toggle flipped
  const account = (await gladys.getCalendarAccounts()).find((a) => a.user.selector === userSelector);
  if (account) await syncUser(account);
  else stopSyncing(userSelector);
});
```

The rules that keep a sync correct, in numbers:

- **User-scoped ids** — every calendar and event `external_id` starts with `ext:<selector>:<user_selector>:`
  (`gladys.externalId(`${userSelector}:…`)`, ≤ 255 characters, 400 otherwise): the provider id after the prefix,
  so an event republished under another calendar of the same user is **moved**, not duplicated. The SDK checks
  the prefix before any request.
- **Who owns which field** — `name`, `description`, `color` are the integration's (overwritten on every push);
  `sync`, `shared`, `selector` are the user's (never touched): a pushed calendar starts private
  (`shared: false`) and reaches the household and the scenes only once the user shares it. `sync: false` empties
  the calendar's events and refuses further pushes (403): skip it, the next full republication restores it when
  the user toggles it back on.
- **Windows prune, nothing else deletes** — with `window: { from, to }`, the integration's events overlapping the
  window (`start < to` and either `end > from` or `start >= from`) and absent from the list are deleted; events
  created by hand in Gladys never are; every pushed event must overlap the window. **One window, one request**:
  more than 500 events in a range means disjoint sub-windows, one request each, a boundary-straddling event
  included in every request whose sub-window it overlaps. Without `window`: pure upsert. A provider-side calendar
  deletion is `deleteCalendar(externalId)`.
- **Bounds** — ≤ 50 calendars per user, ≤ 500 events per request, ≤ 10 000 events per calendar (expand
  recurrences over a bounded horizon, 12 months ahead); `name` 1–100 / 1–200, `description` ≤ 500 / ≤ 1000,
  `location` ≤ 500, `url` http(s) ≤ 500; 30 calendar writes (POST/DELETE) per minute per integration (429
  beyond — a 2000-event calendar is 4 requests). A full-day event is read **by calendar date** (what the provider
  wrote: `'2026-08-15'`, or the date part of an ISO datetime whatever its offset — a Date would be converted to
  UTC first), `end` exclusive, stored at the midnights of the instance timezone; a missing `end` covers the start
  day.
- **Notified both ways** — `onCalendarAccountUpdated(userSelector)` fires after the core applied a change
  (enable, disable, account values, `sync`/`shared` toggle): re-read `getCalendarAccounts()` and
  `getCalendars(userSelector)` and adjust the loops. The event is lost while disconnected, so a calendar
  integration re-reads both on every connection. The integration only ever sees its own calendars — never the
  user's CalDAV, manual or other integrations' ones.

Requires a Gladys with calendar-integrations support (check the `gladys_version` range of your manifest).

### House location

An integration that owns its own geo-dependent logic (water restrictions, pollen, air quality…) polls a third party
at its own pace and publishes devices and states through the generic path — so it pulls the location itself
instead of re-asking it in its config. Declare `"location": true` in the manifest (shown on the install screen:
the home location is sensitive personal data) and fetch the houses at startup and on reconnection — coordinates
change rarely, there is no update event:

```js
gladys.on('connected', async () => {
  const houses = await gladys.getHouses(); // [{ id, name, selector, latitude, longitude }], sorted by name
  const located = houses.filter((house) => house.latitude !== null); // several houses, some maybe unlocated
  await refreshForecasts(located);
});
```

Only these five fields are ever returned — never the alarm mode or code. Without `location: true` the call is a 403. A `type: "weather"` integration needs neither: the core owns that use case and passes the coordinates of the
house in the `options` of every `onWeatherGet` call. An integration that only needs the user to PICK a house
declares a `source: "houses"` select instead (see [dynamic selects](#acting-on-a-specific-device-or-house-dynamic-selects-source-devices--houses)): the stored value is the
`selector` this list returns.

### Scene triggers and actions

An integration can extend the scene editor without a core update: declare `scene_triggers` (what _happens_ — a
licence plate recognized, an object detected, a doorbell pressed, a mail received) and `scene_actions` (an
_operation_ with parameters and a result — take a snapshot, clean these rooms, announce a text) in the manifest,
with the same flat field format as the `config_schema`. The core renders the cards in the scene editor, matches
the events against the filters the user configured, and relays the actions; the integration never learns which
scenes exist.

```json
"scene_triggers": [
  {
    "key": "object_detected",
    "label": { "en": "Object detected", "fr": "Objet détecté" },
    "fields": [
      { "key": "camera", "type": "select", "source": "devices", "label": { "en": "Camera" }, "required": true },
      { "key": "label", "type": "multi_select", "label": { "en": "Object types" },
        "options": [{ "value": "person", "label": { "en": "Person" } }, { "value": "car", "label": { "en": "Car" } }] }
    ],
    "variables": [
      { "key": "label", "type": "string", "label": { "en": "Object type" } },
      { "key": "score", "type": "number", "label": { "en": "Confidence" } }
    ]
  }
],
"scene_actions": [
  {
    "key": "create_snapshot",
    "label": { "en": "Take a snapshot", "fr": "Prendre un instantané" },
    "timeout_seconds": 20,
    "fields": [
      { "key": "camera", "type": "select", "source": "devices", "label": { "en": "Camera" }, "required": true },
      { "key": "caption", "type": "string", "label": { "en": "Caption" } }
    ],
    "outputs": [{ "key": "clip_id", "type": "string", "label": { "en": "Clip identifier" } }]
  }
]
```

```js
// Something happened → fire the trigger. `data` is flat: the core builds the
// matcher's filters from the declared `fields` and the scene variables from
// the declared `variables` ({{triggerEvent.data.label}}); every other key is
// dropped, a declared key absent from `data` is null.
frigate.on('object', async (event) => {
  await gladys.publishSceneEvent('object_detected', {
    camera: gladys.externalId(`cam:${event.camera}`),
    label: event.label,
    score: event.score,
  });
});

// A scene reached the action → run it with the RESOLVED fields (scene
// variables substituted, defaults applied, validated by the core), and return
// the declared outputs for the following actions of the scene.
gladys.onSceneAction('create_snapshot', async (fields) => {
  const clipId = await frigate.snapshot(fields.camera, fields.caption); // your code
  return { clip_id: clipId };
});
```

The doctrines to know, in numbers:

- **State vs event** — a value (a temperature, a switch, a presence) is a device feature published with
  `publishState`; an event says "this happened, with these details" and never sets a state. Needing `>` on an event
  value is the sign the value is a state. `data` is flat and bounded: ≤ 30 keys, one primitive per key (string
  ≤ 1000 characters, finite number, boolean, null) — a snapshot goes through `publishCameraImage`, never here.
- **One event per transition** — "object entered", debounced upstream, never one event per frame: the core admits
  300 events per minute per integration (429 beyond, a counter separate from the states'), sized for a fleet of
  cameras, not for a stream. A resolved call means "accepted and evaluated once", never "a scene ran".
- **Outputs are scalars** — an identifier, a count, a short text (strings capped at 10 000 characters). A picture
  produced by an action is published on a camera device with `publishCameraImage` and consumed by the core's
  "send camera image" scene action. Resolving `undefined` means no outputs; throwing fails that action only — the
  scene logs it and continues, a scene action is never a condition (declare an output and let the scene author
  gate on it).
- **Keys are forever** — a published `key` is never renamed (a renamed key is a removed key for every scene using
  it); a declaration grows in the normal case; removing a key, or adding a `required` action field without a
  `default`, is a breaking update (orphan cards in the editor, 404 on the event, failing action).
- **No loops** — never fire an event as a consequence of a received action: a scene bound to that event would loop
  through the integration.

The ack of a scene action is awaited under its declared `timeout_seconds` (5–120, default 30) — a deadline that
starts when the scene reaches the action, connection wait included. Requires a Gladys with scene-declarations
support (check the `gladys_version` range of your manifest).

### Dashboard widgets

An integration can put its own data on the dashboard without a dedicated core widget: declare up to 5 `widgets`
in the manifest (identity: key, label, icon, per-instance `settings` in the `config_schema` grammar), and produce
the content at runtime in a declarative vocabulary the core renders — no HTML, no iframe, no CSS: the core
guarantees theme, dark mode, responsiveness and translations for every widget, third-party ones included.

```json
"widgets": [
  {
    "key": "vacuum",
    "label": { "en": "Robot vacuum", "fr": "Aspirateur robot" },
    "icon": "wind",
    "settings": [
      { "key": "vacuum", "type": "select", "source": "devices", "label": { "en": "Vacuum" }, "required": true }
    ],
    "action_timeout_seconds": 30
  }
]
```

```js
import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

gladys.onWidgetGet('vacuum', async ({ settings, language, units }) => {
  const state = await robot.getState(settings.vacuum); // your code; settings.vacuum = the chosen device external_id
  return {
    ttl_seconds: 30, // how fast the data moves (10-3600, default 60)
    components: [
      { type: 'value', label: { en: 'Battery' }, device_feature: `${settings.vacuum}:battery` }, // live tile
      {
        type: 'status',
        items: [{ label: { en: 'State', fr: 'État' }, value: state.label[language], color: WIDGET_COLORS.SUCCESS }],
      },
      { type: 'image', key: `cleaning-map-${state.mapHash}`, alt: { en: 'Last cleaning map' } },
      { type: 'button', label: { en: 'Start' }, style: 'primary', action: { key: 'start', params: { mode: 'full' } } },
      { type: 'button', label: { en: 'Dock' }, device_feature: `${settings.vacuum}:dock`, value: 1 },
    ],
  };
});

gladys.onWidgetGetImage(async (imageKey) => {
  const png = await robot.getMap(imageKey); // your code, returns a Buffer
  // The core refuses (never recompresses) anything over 300 KB or 4096 px: resize integration-side.
  return (await sharp(png).resize({ width: 800 }).webp().toBuffer()).toString('base64');
});

gladys.onWidgetAction('vacuum', async (actionKey, params, { settings }) => {
  await robot.send(settings.vacuum, actionKey, params); // your code
  return { en: 'Cleaning started', fr: 'Nettoyage lancé' }; // optional toast
});

robot.on('state', () => gladys.requestWidgetRefresh('vacuum')); // "re-pull me now", rate-limited 1 per 10 s
```

The vocabulary (eight component types, every text a plain string or a multi-language object with `en`):

| `type`      | Fields                                                                                                                                                                                                                      | Renders as                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `text`      | `text`, `variant` (`heading` ≤ 40 \| `body` ≤ 300, default \| `caption` ≤ 80)                                                                                                                                               | escaped plain text; `body` honors line breaks                                                                          |
| `value`     | `value` (number, or string ≤ 12), `unit` ≤ 6, `label` ≤ 24, `icon`, `color` — or `device_feature` (a feature `external_id`) in place of `value`/`unit`                                                                      | a tile; device-bound → live, follows the published states                                                              |
| `gauge`     | `value`, `min` < `max`, `label`, `unit`, `color` — or `device_feature` (range defaulting to the feature's)                                                                                                                  | a radial arc tile                                                                                                      |
| `status`    | `items` (1–10 of `{ label ≤ 40, value (number or string ≤ 40), icon, color }`)                                                                                                                                              | label / value rows with a colored dot                                                                                  |
| `chart`     | `series` (1–4 of `{ name, points: [{ t: ISO date, v }] }` ≤ 300 points) or `device_features` (1–4) + `interval`; `chart_type` (`line` \| `area` \| `bar` \| `stepline`), `title`, `unit`, `annotations` (≤ 8), `now_marker` | the chart box rendering, zero styling; annotations mark the points a curve is read for                                 |
| `card-list` | `display` (`grid` 1–12 items \| `list` 1–8, default), `items` of `{ title ≤ 60, subtitle, date, image (key), badge { text ≤ 16, color }, description ≤ 2000, links (≤ 3 of { url https, label }) }`                         | a poster grid or rows; an item with a description or links opens the core's detail panel                               |
| `image`     | `key` (`^[a-z0-9][a-z0-9-]{0,63}$`), `alt`, `fit` (`cover` \| `contain`)                                                                                                                                                    | an image in a fixed 16:9 frame                                                                                         |
| `button`    | `label` ≤ 24, `icon`, `style` (`primary` \| `secondary` \| `danger`), and exactly one of `action { key, params?, confirm?, fields? }`, `device_feature` + `value`, or `link { url }`                                        | a pill; `action` → `onWidgetAction`, `device_feature` → `onSetValue`, `link` → a new tab; `fields` opens a form on tap |

`icon` is a Feather icon name, `color` a semantic enum (`WIDGET_COLORS`: `neutral` \| `primary` \| `success` \|
`warning` \| `danger` \| `info`), `url`s are https only. The rules that keep every widget card-shaped:

- **The content budget** — at most 8 components, 1 focal (`chart` \| `card-list` \| `image`), 6 tiles (`value` \|
  `gauge`), 2 texts (1 `body`), 1 `status`, 4 `button`s. Beyond a cap the core drops components in content order:
  put what matters first. The card renders its slots in a canonical order (header texts, tiles, focal, status,
  buttons) whatever the order sent; the tiles form a grid whose column count the core picks from their number and
  the card width (3 stay on one row, 4 as 4 or 2 × 2, 5 or 6 as rows of 3 or 2) — nothing to declare, the
  integration does not know the screen width.
- **The payload is never trusted** — unknown component types and fields are dropped, texts truncated, arrays
  capped, a component missing a required field is dropped (never the whole content). `version` (integer ≥ 1,
  default 1) exists for a breaking change the vocabulary is designed never to make; a content over 256 KB is
  refused. An empty `components` array is a valid empty state.
- **Images are served by the integration** — the browser never loads a third-party URL and the core never fetches
  one: the content declares keys, `onWidgetGetImage` resolves the raw base64 of a PNG, JPEG or WebP of at most
  300 KB decoded and 4096 × 4096 px, validated by magic numbers, size and header. The core caches a validated image
  **one hour by key**: when the bytes change, the key must change (`cleaning-map-<hash>`) — and the core never
  recompresses, so resize integration-side (a grid poster renders under 300 px wide, a 16:9 frame under 800 px).
- **Pull, cached, nudged** — the core pulls the content (15 s ack) on mount and on `ttl_seconds` expiry, coalesced
  across open dashboards and cached per settings, language and units; `requestWidgetRefresh(key)` only means
  "re-pull me now" (rate-limited 1 per 10 s per widget). Device-bound tiles and charts follow the published states
  over the core's real-time path with no nudge at all.
- **Read and tap** — a widget at rest displays data and offers buttons; the standard controls (setpoints,
  sliders) are device features rendered by the core widgets. A `button` `action` carries what the integration
  declared (`params`, never user input) and the acting user is anonymous; `confirm: true` asks before sending.
  Typed input exists only **behind a tap**: a button may declare `fields` (≤ 4 of `string` \| `number` \|
  `boolean` \| `select`, the `config_schema` grammar without `section`, `multi_select`, sensitive types or
  `source` — list the options yourself, the content is produced at runtime, and so are the `default`s: the last
  price paid pre-fills the form). The tap opens the form inside the card; the core validates the typed `values`
  against that declaration (unknown key, invalid value, string over 1000 characters, missing required field →
  refused before any relay, defaults applied) and relays them to `onWidgetAction` **next to** `params`, never
  merged into them — absent for an action without `fields`. A typed value is a user **event** (a delivery
  happened, at this price), never a write to the configuration. An invalid `fields` declaration drops the button.

  ```js
  gladys.onWidgetGet('pellets', async () => ({
    components: [
      { type: 'value', value: stock.bags, unit: 'bags', label: { en: 'Stock' } },
      {
        type: 'button',
        label: { en: 'Pallet delivered', fr: 'Palette livrée' },
        icon: 'truck',
        action: {
          key: 'delivery',
          fields: [
            {
              key: 'bags',
              type: 'number',
              required: true,
              min: 1,
              max: 200,
              default: 72,
              label: { en: 'Bags delivered' },
            },
            {
              key: 'price_per_bag',
              type: 'number',
              required: true,
              min: 0,
              max: 50,
              default: stock.lastPrice,
              label: { en: 'Price per bag' },
            },
          ],
        },
      },
    ],
  }));
  gladys.onWidgetAction('pellets', async (actionKey, params, { values }) => {
    await stock.recordDelivery(values.bags, values.price_per_bag); // validated by the core
    return { en: `${values.bags} bags added` };
  });
  ```

**Dev mode**: with `DEBUG=gladys-integration-sdk`, the SDK validates every content and image the handlers resolve
against the vocabulary, the budget and the image bounds, and logs the violations on stderr — "`components[3].value`:
is required", "`status` component dropped by the content budget (a second status list)", "`378 KB decoded, 300 KB
allowed`" — so a widget that ships is a widget that fits. The same checks are exported for your tests:

```js
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';

assert.deepEqual(validateWidgetContent(await buildContent()), []); // [] = rendered exactly as sent
assert.deepEqual(validateWidgetImage(await buildMap()), []);
```

Widget-only integrations (a cinema releases grid, a fuel-price widget) declare the manifest type `"provider"`: no
device surface, a configuration-only page, and at least one capability field (`widgets`, `scene_triggers`,
`scene_actions`, `energy_contracts`). Requires a Gladys with dashboard-widgets support (check the
`gladys_version` range of your manifest; action `fields` need a newer one — an older core drops them and runs the
action without `values`, so refuse an action received without them).

### Energy contracts

An energy contract from any country can be published **entirely** as an external integration: declare
`energy_contracts` in the manifest (a capability field, usable by every type — a connected meter that knows its
supplier's tariffs, a `provider`, a `weather` one) with the contract **templates** the integration offers
(`pricing_mode: "rules"`: a tariff definition the core rule engine computes; `"delegated"`: the integration prices
the intervals itself) and the tariff **calendars** it feeds (day colours, public holidays, critical peak days,
spot prices). The core discovers the templates in the stored manifests, offers them in its contract wizard next to
the community catalogue ones, computes and displays the costs exactly like a catalogue contract — the integration
author never touches the pricing engine, the cost states or the widgets.

```json
"energy_contracts": {
  "templates": [
    { "key": "hydro-quebec-d", "name": { "en": "Hydro-Québec Rate D" }, "country": "CA", "currency": "CAD",
      "timezone": "America/Toronto", "pricing_mode": "rules", "version": "2026-04-01",
      "calendars": ["hq-critical-peaks"], "inputs": [{ "key": "subscribed_power", "type": "number", "unit": "kW" }],
      "tariff": { "tariff_version": 1, "calendars": ["hq-critical-peaks"], "components": ["…"] } },
    { "key": "octopus-agile", "name": { "en": "Octopus Agile" }, "country": "GB", "currency": "GBP",
      "timezone": "Europe/London", "pricing_mode": "delegated", "version": "1",
      "inputs": [{ "key": "region", "type": "select", "options": ["A", "B", "C"] }] }
  ],
  "calendars": [
    { "key": "hq-critical-peaks", "granularity": "day", "values": ["normal", "critical-peak"], "timezone": "America/Toronto" },
    { "key": "spot-fi", "granularity": "fifteen_minutes", "currency": "EUR", "timezone": "Europe/Helsinki" }
  ]
}
```

```js
// Feed a calendar the templates read: upsert by start, the core recomputes the
// costs that read a changed value. A daily calendar takes local dates, a
// 30- or 15-minute one slots aligned on the calendar's local clock.
await gladys.publishEnergyCalendar('hq-critical-peaks', [{ date: '2026-01-12', value: 'critical-peak' }]);
await gladys.publishEnergyCalendar(
  'spot-fi',
  slots.map((s) => ({ starts_at: s.start, price: s.eurPerKwh })),
);
const [last] = await gladys.getEnergyCalendar('spot-fi', { limit: 1 }); // resume after a restart

// Delegated pricing: the core sends the half-hour intervals of ONE billing
// period, the integration returns one cost per interval (the energy only).
gladys.onEnergyPrice(async ({ contract, billing_period, cumulative_before, intervals }) => {
  const prices = await agile.getPrices(contract.inputs.region, intervals); // your provider code
  return intervals.map(({ starts_at, kwh }) => ({ starts_at, cost: kwh * prices.get(starts_at), label: 'Agile' }));
});
gladys.onEnergyCurrent(async ({ contract }) => {
  const slot = await agile.getCurrentSlot(contract.inputs.region);
  return { price: slot.price, valid_until: slot.end, next_price: slot.nextPrice };
});
```

The doctrines to know, in numbers:

- **Calendar keys are global and owned** — one calendar per key per Gladys instance: the first installed
  integration declaring it owns it (granularity, timezone, `day_starts_at`, `values`); a later one is installed
  but its declaration is refused with a warning and its writes get a 403. A key never carries a provider prefix
  (a template written for `spot-fr` works whichever integration feeds `spot-fr`), its granularity never changes
  (a spot calendar follows its market product: 15 minutes for the European day-ahead market), and it survives an
  uninstall (`orphaned` until an integration declaring it is installed again). The core ships no calendar of its
  own, holidays included.
- **Entries are bounded** — ≤ 2,000 per call (20 days of a 15-minute calendar), from 5 years back to 7 days
  ahead, `starts_at` aligned on the granularity (a local midnight for a daily calendar — or `date`, the local
  `YYYY-MM-DD`), exactly one of `value` (within the declared enum, ≤ 64 characters) or `price` (per kWh, may be
  negative: a credit), 400 otherwise. A changed value already used by a computed cost queues a bounded
  recalculation (1 per calendar per 10 minutes); `requestEnergyRecalculation()` nudges the last 48 hours for the
  cases that path does not cover (1/min per integration).
- **Delegated pricing is deterministic and never trusted** — `onEnergyPrice` receives the whole request, field for
  field: `contract` (`{ id, template_key, inputs, currency, timezone, billing_period_start_day }` — never the
  meter nor the consumption history), `billing_period`, `cumulative_before` (kWh before the first interval, per
  scope: `day`, `month`, `billing_period`) and `intervals` (≤ 1,488 of `{ starts_at, kwh, max_power_kw }`, 31
  days, one billing period). Resolve one `{ starts_at, cost, components?, label? }` per requested interval, `cost`
  finite and ≥ 0 in the contract currency (the energy only: the `fixed` components of the tariff are the core's).
  The core checks every interval has exactly one answer under a hostile-payload bound; an invalid payload or a
  throw fails like a timeout — the intervals get **no new** cost (never a silent zero) and the next run retries,
  so a tiered or monthly-total tariff must give the same answer to a retry. Awaited under 30 s.
- **The current price** — `onEnergyCurrent` gets the same state at the current instant (`cumulative`,
  `max_power_kw`) and resolves `{ price, valid_until?, next_price?, label?, next_label? }` (`null` when unknown,
  labels ≤ 64 characters) for the dashboard price widget and the "current price" scene condition, under 5 s.
- **Lifecycle** — a stopped integration keeps its `rules` contracts computed as long as its calendars are fed (a
  missing value applies the component `fallback`); a `delegated` contract accumulates unpriced intervals and
  catches up on return (31 days per run). An uninstall keeps the contracts (`rules` ones keep computing from the
  stored tariff copy, `delegated` ones become `orphaned`) and the calendars. A new template `version` never changes
  a contract silently: the user updates it from the wizard. `getEnergyContracts()` lists the contracts referencing
  the integration's templates with their `status`.

#### Suppliers whose readings arrive after the fact: `publishEnergyConsumption`

A connected meter publishes a cumulative **index** (`energy-sensor` / `index`) and the core derives the rest: the
30-minute consumption, its cost, the attachment to the main electric meter. That index path is a _live_ pipeline,
though: an index published a day late (Hydro-Québec, and every supplier portal that serves yesterday's readings)
collapses a whole day into one half-hour, and a daily total never falls in a critical-peak slot. Such an
integration publishes **no index** but a consumption feature it feeds itself — `energy-sensor` /
`thirty-minutes-consumption` (what a time-of-use or critical-peak tariff needs) or `daily-consumption` (enough for
a flat or a tiered tariff) — and dates every interval:

```js
// 30-minute slots of the Gladys timezone, or `date` (the local YYYY-MM-DD) on a
// daily feature. Upserted by instant: a corrected reading replaces the stored
// value, an unchanged one writes nothing. Split an hourly reading in two equal halves.
const { count, changed_from } = await gladys.publishEnergyConsumption(ids.feature('consumption'), [
  { starts_at: '2026-01-12T05:00:00Z', kwh: 0.42 },
  { starts_at: '2026-01-12T05:30:00Z', kwh: 0.38 },
]);
```

The core derives the cost feature of that consumption (`<external_id>_cost`) and attaches it to the main electric
meter like an index — unless the consumption **is** the main meter (the supplier meter the contract is attached to,
the common case), which stays a root. Intervals are bounded (≤ 2,000 per call, `kwh` finite and ≥ 0, `starts_at`
aligned on a 30-minute slot of the Gladys timezone — a local midnight for a daily feature — elapsed and at most 5
years old, 400 otherwise); the feature must be the integration's, a consumption (400) and created by the user (404:
retry once the device exists), and a consumption the core derives from a published index of the same device is
refused (its states come from the index deltas). Every value that changed queues a cost recalculation of the
feature's root meter from the earliest change, bounded to 1 per meter per 10 minutes — there is no dated
"recalculate from": the publication carries the date. These states never go through `publishStates` (whose
`created_at` is a state's instant, not an interval, and whose rate limit is sized for state changes).

Requires a Gladys with energy-contracts support (check the `gladys_version` range of your manifest;
`publishEnergyConsumption` needs a newer one). The tariff grammar of the `rules` mode is documented with the
community catalogue (`GladysAssistant/energy-contracts`).

### Camera images

A camera is a regular device carrying a `camera`/`image` feature (`DEVICE_FEATURE_CATEGORIES.CAMERA` +
`DEVICE_FEATURE_TYPES.CAMERA.IMAGE`), declared like any feature in the discovered devices. Two complementary
paths, both using the same `image/jpg;base64,...` format (≤ 150 KB):

- **Push** — publish a periodic snapshot with `publishCameraImage` (12 images/minute per device, i.e. one every
  5 s; the continuous video stream is out of scope). The dashboard camera widget updates in real time.
- **Pull** — answer `onGetImage` with a fresh capture when Gladys asks for one (live view of the dashboard
  widget, chat intent "show me the camera"). The ack is awaited under **15 s** instead of the standard 5 s, so an
  ffmpeg-style capture fits.

```js
gladys.onGetImage(async (device) => {
  const jpeg = await captureSnapshot(device); // your camera code (ffmpeg, HTTP snapshot URL…)
  return `image/jpg;base64,${jpeg.toString('base64')}`;
});

// And/or push a snapshot on your own schedule:
await gladys.publishCameraImage(ids.device, `image/jpg;base64,${jpeg.toString('base64')}`);
```

Images never go through `publishState`: dedicated channel, out of the states history and of the 300 states/minute
rate limit.

**Motorized (PTZ) cameras** add ordinary command features to the same device — no new plumbing, movement commands
arrive through `onSetValue` like any feature. `CAMERA.MOVE` is one feature for all movements: the value names the
movement (0 stop — always supported, never listed as an option —, 1 pan left, 2 pan right, 3 tilt up, 4 tilt down,
5 zoom in, 6 zoom out), and the feature's `supported_options` (`[{ value, label, sort_order }]`) declare the subset
this camera actually supports. **Safety rule (MUST)**: bound every continuous move with a watchdog (~5 s) — a lost
stop must never leave the camera rotating against its mechanical stop; prefer a relative step when the camera
supports one. `CAMERA.PRESET` recalls a saved position: the labeled preset list lives in `supported_options` (the
value sent is the option's integer, mapped by the integration to its protocol token), and on re-publish of an
already-created device the options are silently upserted like the `params` — e.g. a preset renamed on the camera.
The optional `pan-position`/`tilt-position`/`zoom-position` types cover cameras that report an absolute position
(numeric read/write, bounds via `min`/`max`, units integration-defined).

### Cloud/local transport badge

Dual-channel integrations (Tuya cloud+LAN, Shelly, eWeLink…) can reach the same device through different
transports, per device and changing over time — without a visible hint the user cannot diagnose a slow or frozen
device. Publish the **effective transport of each device** and Gladys renders it as a badge on the device cards
(with a global summary), in real time:

```js
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

await gladys.publishTransports([
  { external_id: ids.device, transport: DEVICE_TRANSPORTS.LOCAL }, // 'local' | 'cloud' | 'unreachable'
]);
```

This is the lightweight path for live switches (the cloud link drops → `unreachable`, the LAN comes back →
`local`) — no need to re-publish the discovered devices. Purely declarative: the cloud/local logic stays in the
integration, Gladys only displays it.

#### Degraded state

Some situations are "it works, but not in the nominal mode" — a case the three transport values cannot express.
Field example: the device is seen by the local scan but refuses local sessions (rotated local key, another client
holding the connection…) and the integration falls back to cloud — the user sees a perfectly normal `cloud` badge
and nothing invites them to investigate. Flag those entries as **degraded**, with an optional multi-language
`message` (`en` mandatory, ≤ 200 characters per language) giving the reason:

```js
await gladys.publishTransports([
  {
    external_id: ids.device,
    transport: DEVICE_TRANSPORTS.CLOUD,
    degraded: true,
    message: { en: 'Local session refused, falling back to cloud', fr: 'Session locale refusée, bascule cloud' },
  },
]);
```

The badge keeps its transport color with an **orange dot** overlay, and the tooltip shows the message (the global
summary gains a "degraded" count). Degraded is intentionally **orthogonal to the transport** — not a fourth value:
"which channel is in use right now" and "is this the nominal state" are two different pieces of information, and
their combination ("cloud **and** degraded") is what makes the situation diagnosable. Publishing an entry
**without** `degraded` explicitly clears a previously published degraded state — back to nominal, no ghost orange
dot.

Declare the channels the integration supports in the manifest `transports` field (`["local"]`, `["cloud"]` or
both). When both are declared, the Configuration screen shows a standard **"Prefer the local connection"** toggle,
rendered and translated by the core; the integration receives it as the reserved config key
**`GLADYS_PREFER_LOCAL`** (boolean, default `true`) — in `gladys.config` and through `onConfigUpdated`, like any
key, but read-only for the integration (it is a user preference). The preference is a wish, not an order: apply it
when you can, and reflect the per-device reality through `publishTransports`.

```js
gladys.onConfigUpdated(async (config) => {
  usePreferLocal(config.GLADYS_PREFER_LOCAL !== false); // re-route what can be re-routed…
  await gladys.publishTransports(currentTransports()); // …and reflect the actual outcome
});
```

### Sub-containers

Integrations that declare additional containers in their manifest (`containers` field — e.g. a Frigate + Mosquitto
stack) drive their lifecycle through the host API, within the declared bounds. The typical pattern: generate the
config files under `/data/containers/<name>/…`, then start (or restart) the container.

```js
await fs.writeFile('/data/containers/mqtt/mosquitto/config/passwd', passwordFile);
await gladys.startContainer('mqtt', { env: { MQTT_PASSWORD: password } });

const containers = await gladys.getContainers();
const frigate = containers.find((c) => c.name === 'frigate');
const coral = frigate.devices.find((d) => d.class === 'coral-usb');
const detector = coral.granted && coral.available ? 'edgetpu' : 'cpu'; // adapt to what the user granted
```

When the user changes the hardware grants, the affected sub-containers are recreated and `onHardwareUpdated` fires:
regenerate the configs and (re)start what is needed.

Each entry of `container.ports` mirrors the manifest declaration plus the host port Gladys allocated:

```js
// [{ container_port: 5000, protocol: 'tcp', host_port: 42115, label: { en: 'Frigate UI' },
//    name: 'frigate_ui', browsable: true }]
const [{ host_port: frigatePort }] = frigate.ports;
```

The host port is **chosen by Gladys** (a free port, persisted across recreations — never declared in the manifest),
so read it here rather than assuming one; it is `null` as long as none has been assigned (the container has never
started). `browsable` mirrors the manifest field: `true` (default) for a port serving a web UI — the supervision
screen shows an "Open <label>" link — and `false` for a port a browser cannot open, e.g. a WebSocket endpoint
waiting for devices (the OCPP case), which is shown as a plain `<label> : <host_port>` badge instead.

`name` mirrors the optional manifest field of the same port (`[a-z0-9_]{2,20}`, **unique across the whole
manifest**, `null` when the manifest declares none): it is what makes the assigned host port referenceable by the
`{{port:<name>}}` placeholder of the manifest section texts — the way to spell out an address of the instance
inside a sentence shown to the user (see
[Placeholders in section texts](#placeholders-in-section-texts-gladys_host-and-portname)). It pairs naturally with
`browsable: false`: a port that opens no web UI, whose number the user still has to read.

### Mediated network discovery

Integration containers run on a bridge network: LAN **broadcast, mDNS and SSDP traffic never reaches them**, and a
broadcast **emitted** from the container does not cross the NAT to the LAN either (only unicast does, in both
directions). Local discovery (Tuya-style UDP announcements, TP-Link Kasa query/response, Hue mDNS…) therefore goes
through the core, which runs on the host network: **the core captures and emits (network position), the integration
interprets and forges (protocol knowledge)** — the core never parses nor fabricates a payload.

Declare what may be captured in the manifest `network_discovery` field (shown to the user on the install screen,
like `containers` and hardware classes — undeclared captures are rejected with a 403):

```json
"network_discovery": [
  { "type": "udp-broadcast", "ports": [6666, 6667, 7000] },
  { "type": "udp-active-broadcast", "ports": [9999, 20002] },
  { "type": "mdns", "service": "_hue._tcp" }
]
```

Then scan on demand (typically from `onScanRequest`), parse the raw results yourself, join the devices through
unicast, and publish them:

```js
gladys.onScanRequest(async () => {
  // Tuya-style: the devices announce themselves in UDP broadcast on the LAN.
  const announcements = await gladys.scanNetwork('udp-broadcast', { timeoutSeconds: 10 });
  const devices = announcements.map(({ source_ip, payload_base64 }) => {
    const announcement = decodeTuyaPayload(Buffer.from(payload_base64, 'base64')); // your protocol code
    const ids = gladys.externalIds('plug', announcement.gwId);
    return {
      name: `Tuya ${announcement.gwId}`,
      external_id: ids.device,
      // Keep the IP to reach the device in unicast afterwards (unicast crosses the NAT).
      params: [{ name: 'IP_ADDRESS', value: source_ip }],
      features: [],
    };
  });
  await gladys.publishDiscoveredDevices(devices);
});
```

Some protocols are query/response instead of announcement-based: the devices only answer a discovery request, in
unicast **towards the emitter** — so only the core (host network) can play that role. That is the
`udp-active-broadcast` type (TP-Link Kasa style): the integration forges the request (the protocol crypto stays in
the container), the core broadcasts it on a declared port and relays the raw unicast replies:

```js
gladys.onScanRequest(async () => {
  // TP-Link Kasa style: broadcast an encrypted discovery request, the devices answer in unicast.
  const replies = await gladys.scanNetwork('udp-active-broadcast', {
    port: 9999,
    payload: encryptKasaDiscoveryRequest(), // your protocol code, returns a Buffer (≤ 512 bytes)
    timeoutSeconds: 5,
  });
  const devices = replies.map(({ source_ip, payload_base64 }) => {
    const info = decryptKasaReply(Buffer.from(payload_base64, 'base64')); // your protocol code
    const ids = gladys.externalIds('plug', info.deviceId);
    return {
      name: info.alias,
      external_id: ids.device,
      params: [{ name: 'IP_ADDRESS', value: source_ip }],
      features: [],
    };
  });
  await gladys.publishDiscoveredDevices(devices);
});
```

Active-scan guardrails (enforced by the core, the primitive stays uninteresting to hijack): **broadcast only**
(never a unicast towards a chosen target — no LAN sweep by proxy), destination port among the manifest-declared
ports, payload of at most **512 decoded bytes**, **1 scan per 10 seconds** per integration (`429` otherwise).

Raw result shapes: `udp-broadcast` and `udp-active-broadcast` → `[{ source_ip, source_port, payload_base64 }]` (one
entry per received datagram), `mdns` → `[{ name, host, addresses, port, txt }]` (an `mdns` scan browses **every**
`mdns` entry declared in the manifest and merges their results; `txt` is the raw TXT record entries as strings),
`ssdp` → `[{ source_ip, source_mac?, source_port, headers }]` (`headers` is the raw response text; `source_mac` is
**best-effort** — the core looks the responder IP up in its own ARP table and omits the field when the kernel has
no resolved entry, so treat its absence as normal — when present it saves asking the user for a MAC to use
Wake-on-LAN on a freshly discovered device). Scans are synchronous and bounded (`timeoutSeconds` 1–30); requires a
Gladys with mediated-discovery support (check the `gladys_version` range of your manifest).

`parseMdnsTxt(txt)` turns the raw mDNS TXT entries into an object, following the DNS-SD rules (RFC 6763): keys
lowercased (they are case-insensitive), the value is everything after the first `=`, an entry without `=` is a
boolean attribute (`true`), only the first occurrence of a key counts:

```js
import { parseMdnsTxt } from '@gladysassistant/integration-sdk';

const services = await gladys.scanNetwork('mdns', { timeoutSeconds: 5 });
const accessories = services.map(({ name, addresses, port, txt }) => {
  const record = parseMdnsTxt(txt); // ['id=AA:BB:CC:DD:EE:FF', 'md=Eve Energy', 'sf=1'] → { id, md, sf }
  return { id: record.id, model: record.md, paired: record.sf === '0', address: addresses[0], port, name };
});
```

### Wake-on-LAN

Same network position problem, emission side: a magic packet is a UDP broadcast, which never crosses the bridge to
the LAN. Declare `network_wake: true` in the manifest (shown on the install screen, like the other authorization
contracts — an undeclared access is a 403) and ask the core to emit it:

```js
await gladys.wakeOnLan('64:e4:d5:b4:12:66'); // ':', '-' and bare formats accepted
// The device ignores the limited broadcast? Target the subnet broadcast, or tune the port:
await gladys.wakeOnLan('64:e4:d5:b4:12:66', { address: '192.168.1.255', port: 9 });
```

The core always builds the standard fixed 102-byte magic packet itself (6 × `0xFF` + the MAC repeated 16 times):
the integration never provides the payload, so the endpoint is not a general UDP proxy. Rate: **1 wake per
2 seconds** per integration (`429` otherwise) — enough for the usual "retry until the device answers" loop. A
resolved call means the packet was **emitted**, not that the device actually woke up: poll the device to confirm
(and keep the usual retry loop, Wake-on-LAN is fire-and-forget by nature).

### Polling devices

Gladys polls a device — calls `onPoll` — only when it was published with **both** `should_poll: true` and a
`poll_frequency`. `poll_frequency` is in **milliseconds** and must be one of `DEVICE_POLL_FREQUENCIES`
(1 s, 2 s, 10 s, 15 s, 30 s or 1 min): any other value — `300` meant as seconds, `300000` for 5 minutes — makes
`publishDiscoveredDevices` fail with a `400 BAD_REQUEST`, and a device without `should_poll: true` is never polled.

```js
import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';

await gladys.publishDiscoveredDevices([
  {
    name: 'Weather station',
    external_id: ids.device,
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES, // 60000 ms
    features: [/* … */],
  },
]);
```

Once a minute is the slowest pace Gladys schedules. For a slower one (a cloud API with a quota, a user setting in
minutes), keep `EVERY_MINUTES` and skip the polls you do not need in `onPoll`, or drive the refresh with your own
timer instead of `should_poll`. Both fields are read when the user creates the device: changing them in a later
publication does not update a device already created.

### Publishing states efficiently

The host API rate-limits `POST /state` at **300 states per minute** per integration, sized for state _changes_,
not full snapshots. An integration polling a large fleet (e.g. 50 Tuya devices × 6 features) must deduplicate and
publish only the values that actually changed — `publishChangedStates` does it:

```js
await gladys.publishChangedStates(readings.map(({ id, value }) => ({ device_feature_external_id: id, state: value })));

// Also re-send an unchanged value every 30 minutes, so a stable value stays recently dated in Gladys:
await gladys.publishChangedStates(states, { heartbeat: 30 * 60 * 1000 });
```

It takes the `publishStates` format and remembers, per feature, the last value published through it: an entry
equal to it (same `state`, same `text`) is skipped — within the same call too — and nothing is sent when nothing
changed (`{ success: true, count: 0 }`). Batches above 100 states are split, and calls run one after the other — a
poll loop and a live event path can both call it, Gladys receives the values in call order. A value is remembered
only once Gladys accepted it: a failed request (network error, `429`…) throws, and its states are sent again by the next call. The
SDK forgets the values of a device when the user creates, updates or deletes it — Gladys silently drops the states
of a feature that does not exist yet, so they must be re-sent once it does; call
`gladys.forgetPublishedStates(externalId?)` yourself when you know Gladys lost a value.

### Device constants

The SDK exports the canonical category / type / unit strings understood by Gladys — a verbatim mirror of
`server/utils/constants.js` in the Gladys repository — so integrations never have to hand-copy (and typo) them.
The TypeScript typings declare every value as a string literal, so your editor autocompletes them.

```js
import {
  DEVICE_FEATURE_CATEGORIES, // { TEMPERATURE_SENSOR: 'temperature-sensor', SWITCH: 'switch', … }
  DEVICE_FEATURE_TYPES, // grouped by category: { SWITCH: { BINARY: 'binary', POWER: 'power', … }, … }
  DEVICE_FEATURE_UNITS, // { CELSIUS: 'celsius', PERCENT: 'percent', WATT: 'watt', … }
  DEVICE_POLL_FREQUENCIES, // in milliseconds: { EVERY_MINUTES: 60000, EVERY_30_SECONDS: 30000, … }
} from '@gladysassistant/integration-sdk';
```

### Option labels in the user's language

Gladys does not send the user's language at discovery time, so a `supported_options` label you publish as a string
shows the same text to everyone. Publish it as a multi-language object instead (`en` required, each text 1–255
characters) and Gladys shows the user's language, falling back to `en`:

```js
{
  name: 'Air quality',
  external_id: gladys.externalId('homecoach:70ee50:air-quality'),
  category: DEVICE_FEATURE_CATEGORIES.TEXT,
  type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
  read_only: true,
  supported_options: [
    { value: 'healthy', label: { en: 'Healthy', fr: 'Sain', de: 'Gesund', es: 'Saludable' } },
    { value: 'fine', label: { en: 'Fine', fr: 'Correct', de: 'In Ordnung', es: 'Correcto' } },
  ],
}
```

Gladys stores the English text as the label every other consumer reads (HomeKit, Matter, scenes, history). The
object form needs the Gladys release that ships GladysAssistant/Gladys#3209 (expected 5.3.0): an older Gladys refuses
the whole publication with a `400`, so raise your manifest's `gladys_version` minimum before publishing it.

### Logger

The SDK ships the standard integration logger, so every integration does not have to reimplement one. Integration
logs are captured by the Gladys supervisor through the container stdout/stderr: `debug`/`info` write to stdout,
`warn`/`error` to stderr, each line prefixed with an ISO timestamp and the level.

```js
import { logger, createLogger } from '@gladysassistant/integration-sdk';

logger.info('Starting the integration...');
logger.error('Something failed', err);

// Optional: named loggers for the modules of the integration.
const log = createLogger({ name: 'weather-station' });
log.child('poll').debug('refreshing'); // [2026-…Z] [DEBUG] [weather-station:poll] refreshing
```

The level is read from the `LOG_LEVEL` environment variable (`debug` | `info` | `warn` | `error` | `silent`,
case-insensitive, default: `info`; an unknown value falls back to `info`), or pinned with `createLogger({ level })` — handy to silence
an integration's own logs in its tests.

The SDK itself logs its **connection lifecycle** through this logger (under the `gladys-sdk` name), so connectivity
problems are diagnosable from `docker logs` without any configuration: successful (re)connections (`info`), lost
connections and reconnection attempts (`warn`), WebSocket errors, refused tokens and failed resynchronizations
(`error`). The `logger` constructor option replaces it — pass `createLogger({ level: 'silent' })` to keep the SDK
silent, or your own logger to route the lines elsewhere.

### Local state & lifecycle

The SDK keeps `gladys.devices` (array), `gladys.config` (object) and `gladys.connected` (boolean) up to date —
refreshed on every (re)connection and by the `device-created/updated/deleted` and `config-updated` events. The class
extends `EventEmitter`: listen to `gladys.on('connected')` and `gladys.on('disconnected')`, for example to suspend a
polling loop while Gladys is unreachable.

### Behaviour guarantees

- Responds to WebSocket protocol pings (native to the `ws` library).
- Logs the connection lifecycle only (see the Logger section) — silenceable with the `logger` option; everything
  else stays silent unless `DEBUG=gladys-integration-sdk` enables the SDK debug logs on stderr (which also turn on
  the dev-mode validation of the dashboard widget contents and images).
- Persists nothing on disk: everything resynchronizes, `/data` stays fully owned by the integration.
- Unknown message types are ignored silently (forward compatibility).

## Testing your integration

`@gladysassistant/integration-sdk/testing` exports `createFakeGladys()`: a **real** `GladysIntegration` — same
methods, same argument checks, same payload mapping — whose transport is an in-memory Gladys instead of the
network. Pass it to the code under test in place of `new GladysIntegration()`; no server, no WebSocket, no
hand-written stand-in to keep in sync with the SDK.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js'; // your code, takes the gladys client

test('publishes the temperature on poll', async () => {
  const gladys = createFakeGladys({ config: { api_key: 'key' } }); // selector: 'test-integration'
  registerHandlers(gladys);
  await gladys.connect(); // resynchronizes, then awaits your async 'connected' listeners

  const [device] = gladys.fake.discoveredDevices; // published by your 'connected' listener
  assert.deepEqual(await gladys.fake.poll(device), { success: true }); // runs onPoll, resolves with its ack
  assert.equal(gladys.fake.lastState(`${device.external_id}:temperature`), 21.5);
});
```

`gladys.fake` plays Gladys' side:

- **Data served by the host API**, from the `createFakeGladys` options and editable at any time: `devices`,
  `config`, `houses`, `containers`, `contacts`, `webhooks`, `status`, `scanResults` (raw results per scan type,
  e.g. `{ mdns: [...] }`), `linkedUser` (`linkContact` accepts any code), `calendarAccounts`, `calendars` and
  `calendarEvents` (calendar integrations), `energyCalendars` (the declared tariff calendars, key → entries),
  `energyContracts` and `energyConsumption` (the consumption states published after the fact, feature → states).
  The `selector` (default `'test-integration'`) and the SDK `logger` (default silent) are options too.
- **What Gladys received**, as the JSON bodies Gladys would get: `states` and `lastState(featureExternalId)`,
  `discoveredDevices` (the last published list), `connectionStatuses` / `connectionStatus`, `transports`,
  `cameraImages`, `sceneEvents`, `messages`, `scans`, `widgetRefreshes`, `weatherRefreshes`, `publishedCalendars`,
  `publishedCalendarEvents`, `deletedCalendars`, `publishedEnergyCalendars`, `publishedEnergyConsumption`,
  `energyRecalculations`; every host API request in `requests` (`{ method, path, query?, body, status }`) and
  every WebSocket message (acks, nudges) in `wsMessages`.
- **The host API checks** that most often bite: the discovered devices (external_id prefix, known
  category/type/unit, `poll_frequency` among `DEVICE_POLL_FREQUENCIES`) and the states (external_id prefix,
  numeric `state` or string `text`, ISO `created_at`) are validated like Gladys does, and refused with the same
  `400` `GladysApiError` — a rejected request stays in `requests` (`status: 400`) but not in the record above.
  The calendar surface behaves like the core too: `publishCalendars` upserts into `fake.calendars` for an enabled
  user only (404 otherwise; a new calendar starts `sync: true`, `shared: false`), `publishCalendarEvents` upserts,
  moves and prunes `fake.calendarEvents` (403 on a `sync: false` calendar, 404 on an unknown one — flip the toggles
  in `fake.calendars` like a user would), `deleteCalendar` removes both; `publishEnergyCalendar` /
  `getEnergyCalendar` only reach a declared key (403 otherwise) and keep `fake.energyCalendars` sorted;
  `publishEnergyConsumption` only reaches a consumption feature of `fake.devices` (404 on a device not created,
  400 on another feature or on a consumption derived from an index of the same device), refuses an unaligned,
  future or too old interval like the core (the fake Gladys runs in UTC) and upserts `fake.energyConsumption`
  by instant.
- **Gladys calling your handlers**: `gladys.fake.<name>(...)` runs the `on<Name>` handler with the arguments
  the handler receives — preceded by the key for the per-key handlers (`fake.action(key, fields)`,
  `fake.widgetAction(key, actionKey, params, { settings, values })`…) — and resolves with its ack
  `{ success, data?, error? }`: `setValue`, `poll`, `getImage`, `oauthAuthorizeUrl`, `oauthCallback`,
  `sendMessage`, `weatherGet`, `weatherGetImage`, `action`, `sceneAction`, `widgetGet`, `widgetGetImage`,
  `widgetAction`, `energyPrice`, `energyCurrent`, and `webhook` with `{ mode: 'sync' }`. The events resolve once
  handled — `scanRequest`, `deviceCreated` / `deviceUpdated` / `deviceDeleted` (which also update
  `fake.devices`), `configUpdated` (also `fake.config`), `hardwareUpdated`, `webhookUpdated` (also
  `fake.webhooks`), `calendarAccountUpdated` (set `fake.calendarAccounts` / `fake.calendars` to what the user did
  first), `webhook` in the default `fire_and_forget` mode — and, unlike production where an event has no ack, an
  error thrown by their handler rejects so the test sees it. `fake.send(type, payload)` sends any other
  WebSocket message.
- **The lifecycle**: `connect()` / `disconnect()` also await your async `'connected'` / `'disconnected'`
  listeners (an error they throw rejects), and `handleShutdown(cleanup)` does not touch the process signals:
  `gladys.fake.shutdown(signal?)` runs the cleanup then disconnects, without exiting — it disconnects even when the
  cleanup throws, and the cleanup error then rejects.

To make a host API call fail, mock the method — e.g. a rate-limited `publishStates` with the `node:test` mock:

```js
t.mock.method(gladys, 'publishStates', async () => {
  throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'RATE_LIMIT_EXCEEDED: max 300 states per minute');
});
```

## Development

The toolchain is intentionally modern and dependency-light: the native `node:test` runner with
`node:assert/strict` (no test framework), ESLint 10 (flat config) and Prettier 3 run as separate checks, c8 for
coverage thresholds.

```bash
npm install
npm test              # node:test unit tests against a fake Gladys server
npm run coverage      # tests + coverage thresholds (c8)
npm run lint          # ESLint 10, flat config
npm run prettier-check
npm run check-types   # TypeScript typings compile check
```

## License

[Apache-2.0](LICENSE)
