const { EventEmitter } = require('events');
const net = require('net');
const WebSocket = require('ws');

const { computeBackoffDelay } = require('./backoff');
const {
  WEBSOCKET_MESSAGE_TYPES,
  INVALID_ACCESS_TOKEN_CLOSE_CODE,
  MAX_STATES_PER_REQUEST,
  MAX_TRANSPORTS_PER_REQUEST,
  MAX_TRANSPORT_MESSAGE_LENGTH,
  MAX_CAMERA_IMAGE_SIZE,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_ACTIVE_SCAN_PAYLOAD_SIZE,
  MAX_WEBHOOK_SYNC_BODY_SIZE,
  MAX_SCENE_EVENT_DATA_KEYS,
  MAX_SCENE_EVENT_STRING_LENGTH,
  MAX_CALENDARS_PER_USER,
  MAX_CALENDAR_EVENTS_PER_REQUEST,
  MAX_CALENDAR_NAME_LENGTH,
  MAX_CALENDAR_DESCRIPTION_LENGTH,
  MAX_CALENDAR_EVENT_NAME_LENGTH,
  MAX_CALENDAR_EVENT_LOCATION_LENGTH,
  MAX_CALENDAR_EVENT_DESCRIPTION_LENGTH,
  MAX_CALENDAR_EVENT_URL_LENGTH,
  MAX_CALENDAR_EXTERNAL_ID_LENGTH,
  MAX_ENERGY_CALENDAR_ENTRIES_PER_REQUEST,
  ENERGY_CALENDAR_KEY_REGEX,
  MAX_ENERGY_CONSUMPTION_INTERVALS_PER_REQUEST,
  DEVICE_TRANSPORTS,
  DEFAULT_RECONNECT_BASE_DELAY,
  DEFAULT_RECONNECT_MAX_DELAY,
  DEFAULT_REQUEST_TIMEOUT,
  CONTAINER_PULL_POLL_INTERVAL,
  DEFAULT_CONTAINER_PULL_TIMEOUT,
} = require('./constants');
const { debug, isDebugEnabled } = require('./debug');
const { describeError } = require('./errors');
const { HttpClient } = require('./http-client');
const { createLogger } = require('./logger');
const { WIDGET_KEY_REGEX, validateWidgetContent, validateWidgetImage } = require('./widget-content');

const { AUTHENTICATE, AUTHENTICATION, EXTERNAL_INTEGRATION } = WEBSOCKET_MESSAGE_TYPES;

const CALENDAR_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_EVENT_URL_REGEX = /^https?:\/\//;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @description Whether a string is a real calendar date (`YYYY-MM-DD`): the
 * shape, and the round trip through Date.UTC — "2026-02-30" rolls over to
 * March 2 in JavaScript, the Gladys core refuses it on a full-day event.
 * @param {string} value - The candidate date.
 * @returns {boolean} True on a date that exists.
 * @example
 * isCalendarDate('2026-02-30'); // false
 */
function isCalendarDate(value) {
  if (!CALENDAR_DATE_REGEX.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/**
 * @description Serialize a date argument the way the wire expects it: a Date
 * becomes its ISO string, a string must be parseable (`YYYY-MM-DD` included).
 * @param {string|Date} value - The date argument.
 * @param {string} path - The argument name, for the error message.
 * @returns {string} The date as a string.
 * @example
 * toDateString(new Date(), 'publishCalendarEvents: "window.from"');
 */
function toDateString(value, path) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${path} must be a valid Date`);
    }
    return value.toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be an ISO 8601 date string or a Date`);
  }
  return value;
}

/**
 * @description Check an optional bounded string field (`null` means absent,
 * like the host API reads it) and copy it into the mapped entry.
 * @param {object} raw - The raw entry.
 * @param {object} mapped - The entry sent to Gladys.
 * @param {string} field - The field name.
 * @param {number} maxLength - The bound in characters.
 * @param {string} path - The entry path, for the error message.
 * @example
 * copyOptionalText(raw, mapped, 'description', 500, 'publishCalendars: "calendars[0]"');
 */
function copyOptionalText(raw, mapped, field, maxLength, path) {
  if (raw[field] === undefined || raw[field] === null) {
    return;
  }
  if (typeof raw[field] !== 'string' || raw[field].length > maxLength) {
    throw new Error(`${path}.${field}" must be a string of at most ${maxLength} characters`);
  }
  mapped[field] = raw[field];
}

/**
 * @description Check a user-scoped calendar or event external_id: the
 * `ext:<selector>:<user_selector>:` prefix the core enforces, a suffix, and
 * the column bound; unique within the batch.
 * @param {any} externalId - The raw external_id.
 * @param {string} prefix - The expected user-scoped prefix.
 * @param {Set} seen - The ids already seen in the batch.
 * @param {string} path - The entry path, for the error message.
 * @example
 * checkUserScopedExternalId(id, 'ext:gcal:john:', seen, 'publishCalendars: "calendars[0]"');
 */
function checkUserScopedExternalId(externalId, prefix, seen, path) {
  if (
    typeof externalId !== 'string' ||
    !externalId.startsWith(prefix) ||
    externalId.length <= prefix.length ||
    externalId.length > MAX_CALENDAR_EXTERNAL_ID_LENGTH
  ) {
    throw new Error(
      `${path}.external_id" must start with "${prefix}" (the user-scoped prefix) and be at most ${MAX_CALENDAR_EXTERNAL_ID_LENGTH} characters`,
    );
  }
  if (seen.has(externalId)) {
    throw new Error(`${path}.external_id" is a duplicate in the batch`);
  }
  seen.add(externalId);
}

/**
 * @description Check an energy calendar key declared in the manifest.
 * @param {any} key - The raw key.
 * @param {string} method - The method name, for the error message.
 * @example
 * checkEnergyCalendarKey('spot-fr', 'publishEnergyCalendar');
 */
function checkEnergyCalendarKey(key, method) {
  if (typeof key !== 'string' || !ENERGY_CALENDAR_KEY_REGEX.test(key)) {
    throw new Error(
      `${method}: "key" must be a calendar key declared in the manifest energy_contracts.calendars (^[a-z0-9][a-z0-9-]{0,63}$)`,
    );
  }
}

/**
 * Client of the Gladys host API + integration WebSocket (contracts C.2–C.4).
 *
 * Local state kept by the SDK (refreshed on every (re)connection and by the
 * device-created/updated/deleted and config-updated events): `devices`,
 * `config`, `connected`. Lifecycle is observable through the 'connected' and
 * 'disconnected' events (the class extends EventEmitter).
 */
class GladysIntegration extends EventEmitter {
  /**
   * @description Create the integration client. Every option defaults to the
   * environment variables injected in the integration container (contract C.7),
   * and can be overridden for development outside Docker.
   * @param {object} [options] - Options.
   * @param {string} [options.hostApiUrl] - Host API base URL (default: GLADYS_HOST_API_URL).
   * @param {string} [options.token] - Integration JWT (default: GLADYS_INTEGRATION_TOKEN).
   * @param {string} [options.selector] - Integration selector (default: GLADYS_INTEGRATION_SELECTOR).
   * @param {number} [options.reconnectBaseDelay] - First reconnection delay in ms (default: 1000).
   * @param {number} [options.reconnectMaxDelay] - Reconnection delay cap in ms (default: 60000).
   * @param {number} [options.requestTimeout] - Host API request timeout in ms (default: 15000).
   * @param {object} [options.logger] - Logger used for the connection lifecycle
   * logs (default: `createLogger({ name: 'gladys-sdk' })`). Pass
   * `createLogger({ level: 'silent' })` to silence the SDK entirely.
   * @example
   * const gladys = new GladysIntegration();
   */
  constructor(options = {}) {
    super();
    const hostApiUrl = options.hostApiUrl || process.env.GLADYS_HOST_API_URL;
    const token = options.token || process.env.GLADYS_INTEGRATION_TOKEN;
    const selector = options.selector || process.env.GLADYS_INTEGRATION_SELECTOR;
    if (!hostApiUrl) {
      throw new Error('GladysIntegration: missing "hostApiUrl" option (or GLADYS_HOST_API_URL env var)');
    }
    if (!token) {
      throw new Error('GladysIntegration: missing "token" option (or GLADYS_INTEGRATION_TOKEN env var)');
    }
    if (!selector) {
      throw new Error('GladysIntegration: missing "selector" option (or GLADYS_INTEGRATION_SELECTOR env var)');
    }
    this.hostApiUrl = hostApiUrl.replace(/\/+$/, '');
    this.token = token;
    this.selector = selector;
    this.wsUrl = this.hostApiUrl.replace(/^http/, 'ws');
    this.reconnectBaseDelay = options.reconnectBaseDelay || DEFAULT_RECONNECT_BASE_DELAY;
    this.reconnectMaxDelay = options.reconnectMaxDelay || DEFAULT_RECONNECT_MAX_DELAY;
    this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
    this.logger = options.logger || createLogger({ name: 'gladys-sdk' });
    this.httpClient = new HttpClient(this.hostApiUrl, this.token, this.requestTimeout);
    // poll interval of GET /container while a sub-container image downloads
    // (startContainer / restartContainer answered 202); the fake Gladys of
    // the testing helpers lowers it
    this.containerPullPollInterval = CONTAINER_PULL_POLL_INTERVAL;
    this.devices = [];
    this.config = {};
    this.connected = false;
    // feature external_id -> { state, text, at } last published through
    // publishChangedStates (the deduplication memory).
    this.publishedStates = new Map();
    // Tail of the publishChangedStates calls, which run one after the other.
    this.publishChangedStatesQueue = Promise.resolve();
    this.handlers = {};
    this.ws = null;
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
  }

  /**
   * @description Build a namespaced external id: `ext:<selector>:<suffix>`.
   * This is the only documented way to build an external_id.
   * @param {string} suffix - Integration-chosen identifier suffix.
   * @returns {string} The prefixed external id.
   * @example
   * gladys.externalId('switch:binary'); // 'ext:my-integration:switch:binary'
   */
  externalId(suffix) {
    return `ext:${this.selector}:${suffix}`;
  }

  /**
   * @description Build the external ids of ONE physical device: its device id
   * and a factory for its feature ids. `platformId` must be the unique id the
   * external platform gives you (serial number, cloud device id, Zigbee IEEE
   * address, MAC…), never a hard-coded label: external ids must stay globally
   * unique and stable across restarts, they are how Gladys matches states to
   * devices.
   * @param {string} type - Device type namespace, e.g. 'weather-station'.
   * @param {string} platformId - Unique id from the external platform.
   * @returns {object} `{ device, feature(featureKey) }`.
   * @example
   * const ids = gladys.externalIds('plug', '0x00158d0001a2b3c4');
   * ids.device; // 'ext:my-integration:plug:0x00158d0001a2b3c4'
   * ids.feature('power'); // 'ext:my-integration:plug:0x00158d0001a2b3c4:power'
   */
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return {
      device,
      feature: (featureKey) => `${device}:${featureKey}`,
    };
  }

  /**
   * @description Register the handler called when the user actions a device
   * feature. `value` is a number for every feature except the `text` category
   * ones, whose commands are strings — the free text of a `text`/`text`
   * feature, the selected option value of a `text`/`select` dynamic select.
   * Resolving acks the command with success; throwing acks it as failed
   * with the error message.
   * @param {Function} callback - `(device, deviceFeature, value) => Promise`.
   * @example
   * gladys.onSetValue(async (device, feature, value) => {});
   */
  onSetValue(callback) {
    this.handlers.setValue = callback;
  }

  /**
   * @description Register the handler called when the Gladys scheduler asks to
   * poll a device. Only the devices published with `should_poll: true` AND a
   * `poll_frequency` are scheduled. `poll_frequency` is in MILLISECONDS and
   * must be one of DEVICE_POLL_FREQUENCIES (1 s, 2 s, 10 s, 15 s, 30 s or
   * 1 min) — any other value is rejected by publishDiscoveredDevices with a
   * 400. For a slower pace (an API polled every 5 minutes), poll every minute
   * and skip the calls you do not need, or run your own timer. The device
   * received carries `{ external_id, selector, params }`. Respond by
   * publishing states through publishState/publishStates.
   * @param {Function} callback - `(device) => Promise`.
   * @example
   * gladys.onPoll(async (device) => {});
   */
  onPoll(callback) {
    this.handlers.poll = callback;
  }

  /**
   * @description Register the handler called when Gladys needs a FRESH image
   * of one of the integration cameras (live view of the dashboard widget, chat
   * intent "show me the camera"). Capture and resolve the image as an
   * `image/jpg;base64,...` string (≤ 150 KB): it is acked back as `data.image`.
   * The ack is awaited under 15 s (not the standard 5 s) so an ffmpeg-style
   * capture fits; throwing acks the command as failed with the error message.
   * @param {Function} callback - `(device) => Promise<string>`.
   * @example
   * gladys.onGetImage(async (device) => `image/jpg;base64,${await captureJpeg(device)}`);
   */
  onGetImage(callback) {
    this.handlers.getImage = callback;
  }

  /**
   * @description Register the handler called when the user asks for a device
   * scan from the Discovery screen. Respond through publishDiscoveredDevices.
   * @param {Function} callback - `() => Promise`.
   * @example
   * gladys.onScanRequest(async () => {});
   */
  onScanRequest(callback) {
    this.handlers.scanRequest = callback;
  }

  /**
   * @description Register the handler called when the user creates one of the
   * discovered devices in the Gladys UI.
   * @param {Function} callback - `(device) => Promise`.
   * @example
   * gladys.onDeviceCreated(async (device) => {});
   */
  onDeviceCreated(callback) {
    this.handlers.deviceCreated = callback;
  }

  /**
   * @description Register the handler called when the user updates one of the
   * integration devices in the Gladys UI.
   * @param {Function} callback - `(device) => Promise`.
   * @example
   * gladys.onDeviceUpdated(async (device) => {});
   */
  onDeviceUpdated(callback) {
    this.handlers.deviceUpdated = callback;
  }

  /**
   * @description Register the handler called when the user deletes one of the
   * integration devices in the Gladys UI.
   * @param {Function} callback - `(device) => Promise`.
   * @example
   * gladys.onDeviceDeleted(async (device) => {});
   */
  onDeviceDeleted(callback) {
    this.handlers.deviceDeleted = callback;
  }

  /**
   * @description Register the handler called when the user saves the
   * configuration form. Receives the complete new configuration values.
   * @param {Function} callback - `(config) => Promise`.
   * @example
   * gladys.onConfigUpdated(async (config) => {});
   */
  onConfigUpdated(callback) {
    this.handlers.configUpdated = callback;
  }

  /**
   * @description Register the handler called when the user changes the
   * hardware grants of the sub-containers (contract C.4 `hardware-updated`):
   * the affected sub-containers have been recreated; regenerate their
   * configuration (e.g. `edgetpu` vs `cpu` detector) and (re)start what is
   * needed through startContainer/restartContainer.
   * @param {Function} callback - `(containers) => Promise`, `containers` being
   * `[{ name, devices: [{ class, granted, available }] }]`.
   * @example
   * gladys.onHardwareUpdated(async (containers) => {});
   */
  onHardwareUpdated(callback) {
    this.handlers.hardwareUpdated = callback;
  }

  /**
   * @description Register the handler called when the user clicks "Connect" on
   * an `oauth2` or an `account_link` config field. Build and return the
   * provider authorization URL — for `oauth2`: client_id from the config,
   * scopes, a `state` you generate and remember for the callback. The resolved
   * string is acked back to Gladys as `data.authorize_url` and opened in the
   * user browser. For an `account_link` field (a provider that never redirects
   * back — QR sign-in approved in the vendor app, pairing confirmed on a
   * device) `redirectUri` is `undefined`, there is no callback: return the
   * provider sign-in URL, watch for the approval yourself (long-poll the
   * provider), then report it through setConnectionStatus(true).
   * @param {Function} callback - `(key, redirectUri) => Promise<string>`.
   * @example
   * gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => 'https://provider/authorize?...');
   */
  onOAuthAuthorizeUrl(callback) {
    this.handlers.oauthAuthorizeUrl = callback;
  }

  /**
   * @description Register the handler called when the OAuth2 provider
   * redirects back after the user consent. Verify `state`, exchange the code
   * for the tokens, store them through setConfig (keys outside the
   * config_schema), then report through setConnectionStatus(true). Throwing
   * acks the command as failed with the error message.
   * @param {Function} callback - `(key, { code, state, redirectUri }) => Promise`.
   * @example
   * gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {});
   */
  onOAuthCallback(callback) {
    this.handlers.oauthCallback = callback;
  }

  /**
   * @description Register the handler called when Gladys asks a communication
   * integration (manifest `type: "communication"`, contract B.15) to deliver a
   * message in the external channel — a reply of the brain, or a notification
   * forwarded to a user. `contact` carries the identity resolved by Gladys,
   * whose shape follows the manifest `messaging.receive` flag: `{ id }` — the
   * linked contact id — for a bidirectional channel linked by code
   * (`receive: true`, Telegram-style), or the target user's `contact_schema`
   * values for a send-only notification channel (`receive: false`, Free
   * Mobile/CallMeBot-style — e.g. `{ username, access_token }`). Users
   * without a configured identity are skipped by Gladys and never reach the
   * handler. `message` is `{ text, file }` (`file` is a base64 image or
   * null). Resolving acks the command with success; throwing acks it as
   * failed with the error message.
   * @param {Function} callback - `(contact, message) => Promise`.
   * @example
   * gladys.onSendMessage(async (contact, message) => bot.sendMessage(contact.id, message.text));
   * @example
   * // Send-only channel (messaging.receive: false): contact carries the
   * // target user's contact_schema values.
   * gladys.onSendMessage(async (contact, message) => sendSms(contact.username, contact.access_token, message.text));
   */
  onSendMessage(callback) {
    this.handlers.sendMessage = callback;
  }

  /**
   * @description Register the handler called when Gladys asks a weather
   * integration (manifest `type: "weather"`, contract B.18) for the weather —
   * the dashboard weather widget or the chat assistant needs it. `options` is
   * `{ latitude, longitude, language, units }`; `units` is the requesting
   * user's preference, `'metric'` or `'us'`: return values in that unit
   * system (°C, m/s, hPa, mm, km for metric; °F, mph, in, mi for us).
   * Resolve the pivot weather format: `temperature`, `weather` (condition of
   * WEATHER_CONDITIONS) and `datetime` required, plus the optional current
   * fields (`apparent_temperature`, `humidity`, `pressure`, `dew_point`,
   * `wind_speed`, `wind_direction`, `wind_gust`, `visibility`, `cloud_cover`,
   * `uv_index`, `sunrise`, `sunset`, `is_day`), `hours` (≤ 24), `days` (≤ 8)
   * and `alerts` (≤ 10, CAP-style `severity` + `event`, plus an optional
   * phenomenon `type` of WEATHER_ALERT_TYPES). `is_day` (strict boolean, on
   * the current conditions and each hour) drives the day/night rendering
   * variant while `weather` keeps the meteorology — preferred over the
   * deprecated 'night' condition (a rainy night stays 'rain'). The resolved
   * object is acked back as `data.weather` — awaited under 15 s (not the
   * standard 5 s) so a fresh third-party API call fits — then normalized and
   * bounded by the Gladys core (unknown fields dropped, percentages clamped
   * to 0-100, unknown conditions coerced to 'unknown'). Throwing acks the
   * command as failed, and the Gladys provider loop falls through to the
   * next provider.
   * @param {Function} callback - `(options) => Promise<object>`.
   * @example
   * gladys.onWeatherGet(async ({ latitude, longitude, language, units }) => ({
   *   temperature: 21.5,
   *   weather: 'rain',
   *   datetime: new Date().toISOString(),
   *   humidity: 80,
   *   hours: [],
   *   days: [],
   * }));
   */
  onWeatherGet(callback) {
    this.handlers.weatherGet = callback;
  }

  /**
   * @description Register the handler called when Gladys asks a weather
   * integration for one of the provider images declared in the pivot's
   * `images` metadata (contract B.18: vigilance map, rain radar, satellite
   * view…). Registered once for all keys; the callback receives the `key` of
   * the requested image and resolves its RAW base64 (no `data:` URI prefix).
   * The decoded bytes must be a PNG or a JPEG of at most 500 KB: the Gladys
   * core checks the magic numbers and the size, caches the validated image
   * 10 minutes per key, and serves it to the browser from its own origin —
   * the browser never loads a third-party URL. The ack is awaited under 15 s
   * (not the standard 5 s) so a fresh fetch at the provider fits; throwing
   * acks the command as failed.
   * @param {Function} callback - `(key) => Promise<string>`.
   * @example
   * gladys.onWeatherGetImage(async (key) => (await fetchVigilanceMapPng(key)).toString('base64'));
   */
  onWeatherGetImage(callback) {
    this.handlers.weatherGetImage = callback;
  }

  /**
   * @description Send a freshness nudge to Gladys (contract B.18, weather
   * integrations, "trigger, not data"): ask the core to re-pull the weather
   * NOW — through the normal onWeatherGet path — and re-evaluate the
   * weather-alert scene triggers, instead of waiting for the 30-minute
   * scheduled check. The nudge carries no data and expects no answer
   * (fire-and-forget): call it when the integration KNOWS something changed
   * upstream (e.g. a vigilance poll detected a new alert). Rate-limited by
   * the core to 1 per minute per integration, silently dropped beyond — and
   * dropped silently too while the WebSocket is disconnected (the 30-minute
   * floor catches up).
   * @example
   * gladys.requestWeatherRefresh();
   */
  requestWeatherRefresh() {
    this._send(EXTERNAL_INTEGRATION.WEATHER_REFRESH, {});
  }

  /**
   * @description Register the handler called when a user of a calendar
   * integration (manifest `type: "calendar"`, contract
   * capabilities/calendar-type.md) enabled or disabled the integration from
   * the "My calendars" block of the Gladys UI, changed their account values
   * (`account_schema`) or toggled the `sync`/`shared` flag of one of their
   * calendars. Receives the user `selector`, after the core applied the
   * change (on a disable, the user's calendars are already destroyed):
   * re-read getCalendarAccounts() and getCalendars(userSelector) and adjust
   * the sync loops — start syncing a newly enabled user, stop a disabled
   * one, skip a `sync: false` calendar. Fire-and-forget (no ack), and lost
   * while disconnected: on every (re)connection, a calendar integration
   * re-reads both anyway (the `connected` event).
   * @param {Function} callback - `(userSelector) => Promise`.
   * @example
   * gladys.onCalendarAccountUpdated(async (userSelector) => resyncUser(userSelector));
   */
  onCalendarAccountUpdated(callback) {
    this.handlers.calendarAccountUpdated = callback;
  }

  /**
   * @description Register the handler of ONE webhook declared in the manifest
   * `webhooks` field (contract B.17): third-party events pushed from the
   * Internet, relayed by Gladys Plus to the local Gladys then to the
   * integration. Registered per webhook `key`; the callback receives the
   * relayed request `{ method, query, body, contentType }` (`body` is the raw
   * body relayed by the gateway).
   *
   * In `fire_and_forget` mode (the Netatmo-style event stream) the caller was
   * already answered: the resolved value is ignored, and errors are swallowed.
   * Doctrine "trigger, not data": webhook events arrive duplicated, late or
   * out of order, and their payloads are partial — use them to TRIGGER a
   * refresh through the manufacturer API, never apply the payload as a state
   * (that is also what makes lost events painless: the poll stays the source
   * of truth).
   *
   * In `sync` mode (challenge/response registrations, Strava/Microsoft Graph
   * style) the caller awaits the integration response: resolve with
   * `{ status?, contentType?, body? }` (status 200-499, body ≤ 64 KB) and it
   * is returned to the third party through Gladys Plus; resolving `undefined`
   * or throwing lets Gladys answer its default empty `200`.
   * @param {string} key - Webhook key, as declared in the manifest.
   * @param {Function} callback - `({ method, query, body, contentType }) => Promise`.
   * @example
   * gladys.onWebhook('events', async ({ body }) => refreshFromApi());
   * @example
   * gladys.onWebhook('callback', async ({ query }) => ({
   *   status: 200,
   *   contentType: 'application/json',
   *   body: JSON.stringify({ 'hub.challenge': query['hub.challenge'] }),
   * }));
   */
  onWebhook(key, callback) {
    this.handlers[`webhook:${key}`] = callback;
  }

  /**
   * @description Register the handler called when the Gladys Plus webhook
   * availability changes (contract B.17): Gladys Plus linked or unlinked, Open
   * API key created or changed. Receives the same `{ available, webhooks }`
   * object as getWebhooks(): re-register the fresh URLs at the third party
   * when `available` turns true, or degrade to poll only when it turns false.
   * @param {Function} callback - `({ available, webhooks }) => Promise`.
   * @example
   * gladys.onWebhookUpdated(async ({ available, webhooks }) => {});
   */
  onWebhookUpdated(callback) {
    this.handlers.webhookUpdated = callback;
  }

  /**
   * @description Register the handler of ONE action declared in the manifest
   * `actions` field (contract C.1) — connection test, identify, protocol
   * detection… — run when the user clicks its button in the Configuration
   * screen. Registered per action `key`; receives the values of the action
   * `fields` mini-form, validated by the core, the declared `default` of
   * every field the user left empty applied (a `source: "devices"` select
   * carries the chosen device `external_id`, a `source: "houses"` one the
   * chosen house `selector`). The resolved value (a string or a multi-language
   * object) is acked back as `data.message` and shown under the button —
   * throwing shows the error message instead. The ack is awaited under the
   * action's declared `timeout_seconds` (not the standard 5 s), so long
   * operations are fine.
   * @param {string} key - Action key, as declared in the manifest.
   * @param {Function} callback - `(fields) => Promise<string|object>`.
   * @example
   * gladys.onAction('detect_protocol', async (fields) => `Protocol 3.3 detected on ${fields.ip}`);
   */
  onAction(key, callback) {
    this.handlers[`action:${key}`] = callback;
  }

  /**
   * @description Register the handler of ONE scene action declared in the
   * manifest `scene_actions` field (contract "scene triggers and actions"):
   * an operation a scene author placed in a scene — take a snapshot, clean
   * these rooms, announce a text. Registered per action `key`; receives the
   * RESOLVED `fields` (scene variables substituted, defaults applied,
   * validated by the core against the declaration — `source: "devices"`
   * fields carry the chosen device `external_id`, `source: "houses"` fields
   * the chosen house `selector`). Resolve an object of the
   * declared `outputs` (scalars only: an identifier, a count, a short text —
   * never an image, which takes the camera path) and it is acked back as
   * `data.outputs` for the following actions of the scene to read
   * (`{{<column>.<row>.<key>}}`); resolve `undefined` for no outputs.
   * Throwing acks the command as failed: the scene logs the error and
   * continues (a scene action is never a condition). The ack is awaited
   * under the action's declared `timeout_seconds` (default 30 s, not the
   * standard 5 s), a deadline that starts when the scene reaches the action.
   * Never fire a scene event as a consequence of a received action: a scene
   * bound to that event would loop through the integration.
   * @param {string} key - Scene action key, as declared in the manifest.
   * @param {Function} callback - `(fields) => Promise<object|void>`.
   * @example
   * gladys.onSceneAction('create_snapshot', async (fields) => {
   *   const clipId = await frigate.snapshot(fields.camera, fields.caption);
   *   return { clip_id: clipId };
   * });
   */
  onSceneAction(key, callback) {
    this.handlers[`sceneAction:${key}`] = callback;
  }

  /**
   * @description Register the handler of ONE dashboard widget declared in the
   * manifest `widgets` field (contract "dashboard widgets"): Gladys pulls the
   * content to render when a dashboard shows the widget (on mount, on TTL
   * expiry, on a nudge — coalesced and cached core-side per settings,
   * language and units). Registered per widget `key`; receives
   * `{ settings, language, units }` — `settings` the instance values of the
   * declared `settings` with defaults applied (a `source: "devices"` setting
   * carries the chosen device `external_id`, a `source: "houses"` setting the
   * chosen house `selector`), `language` the requesting
   * user's ISO 639-1 code, `units` `'metric'` or `'us'`: localize the texts
   * and the values from them. Resolve the content `{ version?, ttl_seconds?,
   * components }` in the core vocabulary (`text`, `value`, `gauge`, `status`,
   * `chart`, `card-list`, `image`, `button`) — it is acked back as
   * `data.content`, awaited under 15 s (not the standard 5 s) so a
   * third-party API call fits, then normalized, bounded and trimmed to the
   * content budget by the core. `ttl_seconds` (10-3600, default 60) is the
   * reload policy: choose it from how fast the data moves. Throwing acks the
   * command as failed and the card shows "data unavailable" with the error
   * message. In dev mode (DEBUG=gladys-integration-sdk) the SDK validates
   * every resolved content against the vocabulary and the budget, and logs
   * what the core would drop or truncate — see validateWidgetContent.
   * @param {string} key - Widget key, as declared in the manifest.
   * @param {Function} callback - `({ settings, language, units }) => Promise<object>`.
   * @example
   * gladys.onWidgetGet('vacuum', async ({ settings, language }) => ({
   *   ttl_seconds: 30,
   *   components: [
   *     { type: 'status', items: [{ label: { en: 'State', fr: 'État' }, value: { en: 'Docked', fr: 'Sur la base' }, color: 'success' }] },
   *     // a `source: "devices"` setting is already the device external_id
   *     { type: 'value', label: { en: 'Battery' }, device_feature: `${settings.vacuum}:battery` },
   *     { type: 'button', label: { en: 'Start' }, style: 'primary', action: { key: 'start' } },
   *   ],
   * }));
   */
  onWidgetGet(key, callback) {
    this.handlers[`widget:${key}`] = callback;
  }

  /**
   * @description Register the handler called when Gladys needs the bytes of
   * an image declared in a widget content (an `image` component `key`, a
   * `card-list` item `image`) — contract "dashboard widgets", section 6:
   * the browser never loads a third-party URL and the core never fetches one
   * (an SSRF from a sandboxed container otherwise), so the integration
   * serves the bytes on demand. Registered once for all keys (image keys are
   * integration-scoped: two widgets sharing a poster share one key, one
   * download, one cache entry); the callback receives the requested
   * `imageKey` and resolves its RAW base64 (no `data:` URI prefix). The
   * decoded bytes must be a PNG, a JPEG or a WebP of at most 300 KB whose
   * header declares at most 4096 × 4096 pixels: the core checks the magic
   * numbers, the size and the pixel size, and REFUSES — it never
   * recompresses — so resize integration-side (`sharp` at the display width:
   * a grid poster renders under 300 px wide, a 16:9 frame under 800 px). The
   * core caches a validated image ONE HOUR by key: when the bytes change, the
   * key must change (a content-addressed suffix, a timestamp) — a robot's
   * cleaning map is `cleaning-map-<hash>`, a poster key is naturally stable.
   * The ack is awaited under 15 s. In dev mode (DEBUG=gladys-integration-sdk)
   * the SDK validates every resolved image and logs why the core would
   * refuse it — see validateWidgetImage.
   * @param {Function} callback - `(imageKey) => Promise<string>`.
   * @example
   * gladys.onWidgetGetImage(async (imageKey) => {
   *   const poster = await fetchPoster(imageKey); // your code, returns a Buffer
   *   return (await sharp(poster).resize({ width: 300 }).webp().toBuffer()).toString('base64');
   * });
   */
  onWidgetGetImage(callback) {
    this.handlers.widgetGetImage = callback;
  }

  /**
   * @description Register the handler of the `button` actions of ONE
   * dashboard widget (contract "dashboard widgets", section 7): the user
   * tapped a button declared with an `action` in the widget content. Registered
   * per widget `key`; receives the tapped `actionKey`, the `params` declared
   * in the last content the core normalized (never user input — a dashboard
   * can hang on a public wall panel) and `{ settings, values }` — `settings`
   * the validated instance settings, `values` the form of a button declaring
   * `fields` (section 7: at most 4 string/number/boolean/select fields
   * opened by the tap, pre-filled with the declared defaults), validated by
   * the core against that declaration, defaults applied, and ABSENT for an
   * action without `fields`. A typed value is a user event (a delivery
   * happened, at this price), never a write to the configuration. Resolve
   * an optional message shown as a toast — a
   * string, a multi-language object, or `{ message }` — ≤ 200 characters
   * per language; resolve `undefined` for none. After a successful action the
   * core drops the cached content of the widget and every open instance
   * refetches: no nudge needed. Throwing acks the command as failed and the
   * error message reaches the user. The ack is awaited under the widget's
   * declared `action_timeout_seconds` (default 30 s); rate-limited core-side
   * to 30 actions per minute per integration.
   * @param {string} key - Widget key, as declared in the manifest.
   * @param {Function} callback - `(actionKey, params, { settings, values }) => Promise<string|object|void>`.
   * @example
   * gladys.onWidgetAction('vacuum', async (actionKey, params, { settings }) => {
   *   await robot.send(settings.vacuum, actionKey, params); // your code
   *   return { en: 'Cleaning started', fr: 'Nettoyage lancé' };
   * });
   * @example
   * // A button declaring fields: { type: 'button', label: { en: 'Pallet delivered' }, action: { key: 'delivery',
   * //   fields: [{ key: 'bags', type: 'number', required: true, min: 1, max: 200, default: 72, label: { en: 'Bags' } }] } }
   * gladys.onWidgetAction('pellets', async (actionKey, params, { values }) => {
   *   await stock.recordDelivery(values.bags); // validated by the core: a number between 1 and 200
   *   return { en: `${values.bags} bags added` };
   * });
   */
  onWidgetAction(key, callback) {
    this.handlers[`widgetAction:${key}`] = callback;
  }

  /**
   * @description Send a freshness nudge to Gladys for ONE dashboard widget
   * (contract "dashboard widgets", section 3, "trigger, not data"): the core
   * drops the cached content of the widget and every open instance
   * re-pulls it through the normal onWidgetGet path, instead of waiting for
   * the content `ttl_seconds`. The nudge carries no data and expects no
   * answer (fire-and-forget): call it when the integration KNOWS the data
   * changed (the vacuum reported a state change). Rate-limited by the core to
   * 1 per 10 seconds per (integration, widget key), silently dropped beyond
   * (the first nudge of a window wins, the tile follows within seconds at
   * worst) — and dropped silently too while the WebSocket is disconnected
   * (the TTL catches up). Live device-bound tiles and charts need no nudge:
   * they follow the published states over the core's real-time path.
   * @param {string} key - Widget key, as declared in the manifest.
   * @example
   * robot.on('state', () => gladys.requestWidgetRefresh('vacuum'));
   */
  requestWidgetRefresh(key) {
    if (typeof key !== 'string' || !WIDGET_KEY_REGEX.test(key)) {
      throw new Error('requestWidgetRefresh: "key" must be a widget key declared in the manifest (^[a-z0-9_]{2,32}$)');
    }
    this._send(EXTERNAL_INTEGRATION.WIDGET_REFRESH, { key });
  }

  /**
   * @description Register the handler of the delegated pricing of the energy
   * contracts capability (manifest `energy_contracts.templates[]` with
   * `pricing_mode: "delegated"`, contract capabilities/energy-contracts.md,
   * section 3): the core rule engine cannot express the tariff, so the core
   * sends the consumption intervals of ONE billing period and the integration
   * prices them. Receives the whole request, field for field — `contract`
   * (`{ id, template_key, inputs, currency, timezone, billing_period_start_day }`,
   * never the meter nor the consumption history), `billing_period`
   * (`{ starts_at, ends_at }`), `cumulative_before` (kWh of the priced feature
   * before the first interval, per scope: `{ day, month, billing_period }`)
   * and `intervals` (≤ 1,488 half-hour intervals of `{ starts_at, kwh,
   * max_power_kw }`, 31 days). Resolve ONE cost per requested interval, in the
   * contract currency: `[{ starts_at, cost, components?, label? }]` — `cost`
   * a finite number ≥ 0 (the energy only: the `fixed` components of the
   * tariff are computed by the core), `components` an optional breakdown
   * (`{ energy, tax }`, keys `[a-z0-9_-]{1,32}`). It is acked back as
   * `data.costs`, awaited under 30 s (not the standard 5 s). A retry or a
   * catch-up request carries the same state as a first request for the same
   * intervals, so a tiered or monthly-total tariff must give the same answer.
   * An invalid payload (a missing interval, a negative or absurd cost) fails
   * like a timeout: the intervals get no new cost state and the next run of
   * the job retries. Throwing acks the command as failed, same effect.
   * @param {Function} callback - `({ contract, billing_period, cumulative_before, intervals }) => Promise<Array>`.
   * @example
   * gladys.onEnergyPrice(async ({ contract, intervals }) => {
   *   const prices = await agile.getPrices(contract.inputs.region, intervals); // your code
   *   return intervals.map(({ starts_at, kwh }) => ({ starts_at, cost: kwh * prices.get(starts_at) }));
   * });
   */
  onEnergyPrice(callback) {
    this.handlers.energyPrice = callback;
  }

  /**
   * @description Register the handler of the current price of a delegated
   * energy contract (contract capabilities/energy-contracts.md, section 3):
   * the dashboard price widget and the "current price" scene condition ask
   * what the kWh costs right now and when that changes. Receives the same
   * state as onEnergyPrice at the current instant — `contract`,
   * `billing_period`, `cumulative` (`{ day, month, billing_period }`) and
   * `max_power_kw` (the peak of the last interval). Resolve
   * `{ price, valid_until?, next_price?, label?, next_label? }` — `price`
   * the current price per kWh in the contract currency (`null` when
   * unknown), `valid_until` the instant it changes (ISO date or Date,
   * `null` when unknown), `next_price` the price from then on, the labels
   * short names of the periods (≤ 64 characters, e.g. "Off-peak"). It is
   * acked back as `data`, awaited under 5 s. Throwing acks the command as
   * failed: the widget shows the price as unavailable.
   * @param {Function} callback - `({ contract, billing_period, cumulative, max_power_kw }) => Promise<object>`.
   * @example
   * gladys.onEnergyCurrent(async ({ contract }) => {
   *   const slot = await agile.getCurrentSlot(contract.inputs.region); // your code
   *   return { price: slot.price, valid_until: slot.end, next_price: slot.nextPrice };
   * });
   */
  onEnergyCurrent(callback) {
    this.handlers.energyCurrent = callback;
  }

  /**
   * @description Send an energy calendar freshness nudge to Gladys (contract
   * capabilities/energy-contracts.md, section 3, "trigger, not data"): the
   * integration has a new value in one of the tariff calendars it declares,
   * and asks the core to recompute the recent costs (the last 48 hours) of
   * the meters whose contract reads them, instead of waiting for the next
   * scheduled recalculation. The nudge carries no data and expects no
   * answer (fire-and-forget). publishEnergyCalendar already queues a
   * bounded recalculation from the earliest changed entry: this nudge is
   * for the cases it does not cover. Rate-limited by the core to 1 per
   * minute per integration, silently dropped beyond, ignored from an
   * integration declaring no calendar — and dropped silently too while the
   * WebSocket is disconnected.
   * @example
   * gladys.requestEnergyRecalculation();
   */
  requestEnergyRecalculation() {
    this._send(EXTERNAL_INTEGRATION.ENERGY_CALENDAR_REFRESH, {});
  }

  /**
   * @description Open the WebSocket, authenticate, resynchronize local state
   * (GET /device + GET /config), then resolve. Reconnects automatically for
   * life with an exponential backoff of min(1s * 2^n, 60s); every reconnection
   * re-authenticates and resynchronizes. When Gladys refuses the token (close
   * code 4000) the loop stays armed but jumps straight to the max delay —
   * the refusal may be transient (token validation error at boot) and a live
   * container that stops reconnecting is never recreated by the supervisor.
   * connect() rejects when the refusal happens during the initial connection.
   * @returns {Promise<void>} Resolves once authenticated and resynchronized.
   * @example
   * await gladys.connect();
   */
  async connect() {
    this.shouldReconnect = true;
    return new Promise((resolve, reject) => {
      const initial = {
        settled: false,
        resolve: () => {
          if (!initial.settled) {
            initial.settled = true;
            resolve();
          }
        },
        reject: (error) => {
          if (!initial.settled) {
            initial.settled = true;
            reject(error);
          }
        },
      };
      this._openWebSocket(initial);
    });
  }

  /**
   * @description Close the connection cleanly and stop reconnecting.
   * @returns {Promise<void>} Resolves once the socket is closed.
   * @example
   * await gladys.disconnect();
   */
  async disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connected = false;
      return;
    }
    await new Promise((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close(1000);
    });
  }

  /**
   * @description Exit gracefully on SIGTERM/SIGINT (sent by the supervisor
   * when the container stops): run the optional cleanup, disconnect cleanly,
   * then exit with code 0. Cleanup/disconnect errors are swallowed — the
   * process is stopping anyway. Call it once, next to the other handlers.
   * @param {Function} [cleanup] - `(signal) => Promise`, run before disconnecting.
   * @example
   * gladys.handleShutdown(async () => stopPolling());
   */
  handleShutdown(cleanup) {
    const shutdown = async (signal) => {
      debug(`received ${signal}, shutting down`);
      if (cleanup) {
        try {
          await cleanup(signal);
        } catch (e) {
          debug('shutdown cleanup failed', e.message);
        }
      }
      try {
        await this.disconnect();
      } catch (e) {
        debug('disconnect failed during shutdown', e.message);
      }
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  /**
   * @description Publish the complete list of discovered devices (replaces the
   * previous one). Devices are shown in the Discovery screen of the Gladys UI,
   * where the user creates them. A polled device carries `should_poll: true`
   * and a `poll_frequency` in MILLISECONDS among DEVICE_POLL_FREQUENCIES
   * (see onPoll) — any other value is rejected with a 400.
   * @param {Array} devices - Devices in the standard Gladys format.
   * @returns {Promise<object>} `{ success, count }`.
   * @example
   * await gladys.publishDiscoveredDevices([{ name: 'Sensor', external_id: gladys.externalId('sensor'), features: [] }]);
   */
  async publishDiscoveredDevices(devices) {
    return this.httpClient.post('/discovered_device', { devices });
  }

  /**
   * @description Fetch the integration devices actually created by the user,
   * and refresh `gladys.devices`.
   * @returns {Promise<Array>} The devices.
   * @example
   * const devices = await gladys.getDevices();
   */
  async getDevices() {
    const devices = await this.httpClient.get('/device');
    this.devices = devices;
    return devices;
  }

  /**
   * @description Fetch the houses configured in Gladys with their coordinates
   * (contract C.3), sorted by name — for the integrations that own their own
   * geo-dependent logic (water restrictions, pollen, air quality…) and poll a
   * third party at their own pace: the location is entered once in the core
   * instead of being re-asked in every integration's config. Requires
   * `location: true` in the manifest (shown on the install screen): the home
   * location is sensitive personal data, so an undeclared access is rejected
   * with a 403 `GladysApiError`. `latitude`/`longitude` are `null` when the
   * user has not located the house, and several houses may exist: handle
   * both. Only these five fields are returned — never the alarm mode or
   * code. Coordinates change rarely: fetch at startup and on reconnection,
   * there is no update event. A `type: "weather"` integration needs neither
   * this method nor `location: true` — the coordinates of the house reach it
   * in the `options` of every onWeatherGet call.
   * @returns {Promise<Array>} The houses: `[{ id, name, selector, latitude, longitude }]`.
   * @example
   * const [house] = await gladys.getHouses();
   */
  async getHouses() {
    return this.httpClient.get('/house');
  }

  /**
   * @description Publish one device feature state. `value` is a number, or
   * `{ text }` for a text state, or `{ state, created_at }` for a past state.
   * @param {string} featureExternalId - The feature external_id.
   * @param {number|object} value - The state value.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishState(gladys.externalId('sensor:temperature'), 21.5);
   */
  async publishState(featureExternalId, value) {
    const state = { device_feature_external_id: featureExternalId };
    if (value !== null && typeof value === 'object') {
      if (value.text !== undefined) {
        state.text = value.text;
      }
      if (value.state !== undefined) {
        state.state = value.state;
      }
      if (value.created_at !== undefined) {
        state.created_at = value.created_at;
      }
    } else {
      state.state = value;
    }
    return this.publishStates([state]);
  }

  /**
   * @description Publish a batch of device feature states (max 100 per request,
   * contract C.3).
   * @param {Array} states - States: `{ device_feature_external_id, state|text, created_at? }`.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishStates([{ device_feature_external_id: 'ext:demo:sensor:temperature', state: 21.5 }]);
   */
  async publishStates(states) {
    if (!Array.isArray(states)) {
      throw new Error('publishStates: "states" must be an array');
    }
    if (states.length > MAX_STATES_PER_REQUEST) {
      throw new Error(`publishStates: maximum ${MAX_STATES_PER_REQUEST} states per request`);
    }
    return this.httpClient.post('/state', { states });
  }

  /**
   * @description Publish only the states whose value changed since the last
   * one published through this method for the same feature — POST /state is
   * rate-limited to 300 states per minute per integration, sized for state
   * CHANGES, not for full snapshots. Takes the publishStates format; an entry
   * equal to the previous value of its feature (same `state`, same `text`)
   * is skipped, also within the same call. Batches above 100 states are
   * split into several requests. Calls run one after the other (each waits
   * for the previous one), so Gladys receives the values in call order. A
   * value is remembered only once Gladys accepted it: when a request fails
   * (network error, 429…) the error is thrown and its states are re-sent by
   * the next call. The remembered
   * values of a device are forgotten when the user creates, updates or
   * deletes it — Gladys silently drops the states of a feature that does not
   * exist yet, so they must be re-sent once it does.
   * @param {Array} states - States: `{ device_feature_external_id, state|text, created_at? }`.
   * @param {object} [options] - Options.
   * @param {number} [options.heartbeat] - Re-publish an unchanged value once its
   * last publication is older than this many milliseconds (default: never) —
   * e.g. so that a stable value is still dated recently in Gladys.
   * @returns {Promise<object>} `{ success, count }`, `count` being the number of
   * states actually published (0 when nothing changed: no request is sent).
   * @example
   * await gladys.publishChangedStates(readings.map(({ id, value }) => ({ device_feature_external_id: id, state: value })));
   * @example
   * await gladys.publishChangedStates(states, { heartbeat: 30 * 60 * 1000 });
   */
  async publishChangedStates(states, options = {}) {
    if (!Array.isArray(states)) {
      throw new Error('publishChangedStates: "states" must be an array');
    }
    const { heartbeat } = options;
    if (heartbeat !== undefined && (typeof heartbeat !== 'number' || !(heartbeat > 0))) {
      throw new Error('publishChangedStates: "heartbeat" must be a positive number of milliseconds');
    }
    states.forEach((state) => {
      if (state === null || typeof state !== 'object' || typeof state.device_feature_external_id !== 'string') {
        throw new Error('publishChangedStates: every state must carry a "device_feature_external_id"');
      }
    });
    // One call at a time: overlapping requests could reach Gladys out of
    // order and leave it on an older value than the remembered one, which
    // would then never be re-sent.
    const run = this.publishChangedStatesQueue.then(() => this._publishChangedStates([...states], heartbeat));
    this.publishChangedStatesQueue = run.catch(() => {});
    return run;
  }

  /**
   * @description Body of publishChangedStates, run once the previous calls
   * are done.
   * @param {Array} states - Validated states.
   * @param {number} [heartbeat] - Validated heartbeat, in milliseconds.
   * @returns {Promise<object>} `{ success, count }`.
   * @example
   * await this._publishChangedStates(states, undefined);
   */
  async _publishChangedStates(states, heartbeat) {
    const now = Date.now();
    // Last value of each feature, this call's earlier entries included.
    const previous = new Map();
    const changed = states.filter((state) => {
      const id = state.device_feature_external_id;
      const last = previous.has(id) ? previous.get(id) : this.publishedStates.get(id);
      previous.set(id, { state: state.state, text: state.text, at: now });
      return (
        last === undefined ||
        last.state !== state.state ||
        last.text !== state.text ||
        (heartbeat !== undefined && now - last.at >= heartbeat)
      );
    });
    for (let start = 0; start < changed.length; start += MAX_STATES_PER_REQUEST) {
      const batch = changed.slice(start, start + MAX_STATES_PER_REQUEST);
      // Remembered BEFORE the request, so that a forget happening meanwhile
      // (device created during the request) is not undone by its success;
      // forgotten again if Gladys did not take them.
      const at = Date.now();
      batch.forEach(({ device_feature_external_id: id, state, text }) => {
        this.publishedStates.set(id, { state, text, at });
      });
      try {
        await this.publishStates(batch);
      } catch (e) {
        batch.forEach(({ device_feature_external_id: id }) => this.publishedStates.delete(id));
        throw e;
      }
    }
    return { success: true, count: changed.length };
  }

  /**
   * @description Forget the values remembered by publishChangedStates, so the
   * next call publishes them again whatever they hold. Done automatically
   * when the user creates, updates or deletes a device; call it yourself
   * when you know Gladys lost a value.
   * @param {string} [externalId] - A feature external_id, or a device
   * external_id (forgets all its `<device>:<feature>` ids). Omitted: forget
   * everything.
   * @example
   * gladys.forgetPublishedStates(ids.device);
   */
  forgetPublishedStates(externalId) {
    if (externalId === undefined) {
      this.publishedStates.clear();
      return;
    }
    const prefix = `${externalId}:`;
    [...this.publishedStates.keys()].forEach((id) => {
      if (id === externalId || id.startsWith(prefix)) {
        this.publishedStates.delete(id);
      }
    });
  }

  /**
   * @description Publish a new image of a camera device of the integration
   * (contract C.3): a device carrying a `camera`/`image` feature, declared
   * like any feature in the discovered devices. The dashboard camera widget
   * updates in real time. Images never go through the states path: dedicated
   * channel, out of the states history and rate limit — but limited to 150 KB
   * and 12 images/minute per device (the continuous video stream is not the
   * scope: this is the periodic snapshot path).
   * @param {string} deviceExternalId - The camera device external_id.
   * @param {string} image - The image, as an `image/jpg;base64,...` string (≤ 150 KB).
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishCameraImage(gladys.externalId('cam:abc'), `image/jpg;base64,${jpegBase64}`);
   */
  async publishCameraImage(deviceExternalId, image) {
    if (typeof image !== 'string') {
      throw new Error('publishCameraImage: "image" must be an "image/jpg;base64,..." string');
    }
    if (image.length > MAX_CAMERA_IMAGE_SIZE) {
      throw new Error(`publishCameraImage: maximum image size is ${MAX_CAMERA_IMAGE_SIZE} bytes (150 KB)`);
    }
    return this.httpClient.post('/camera/image', { device_external_id: deviceExternalId, image });
  }

  /**
   * @description Publish the per-device transport status of the integration
   * devices (contract C.3): `'local'`, `'cloud'` or `'unreachable'`, stored in
   * the reserved GLADYS_TRANSPORT device param and rendered as a badge on the
   * devices in the Gladys UI, in real time. This is the lightweight path for
   * live switches (the cloud link drops → 'unreachable', the LAN comes back →
   * 'local') — no need to re-publish the discovered devices. Unknown external
   * ids are ignored silently by Gladys. The matching user preference arrives
   * in `gladys.config.GLADYS_PREFER_LOCAL` (a wish, not an order: apply it
   * when you can, and reflect the per-device reality here).
   *
   * An entry can also carry the degraded state — "it works, but not in the
   * nominal mode", which the three transport values cannot express (field
   * case: device seen by the local scan but local sessions refused → cloud
   * fallback looks like a perfectly normal 'cloud' badge): `degraded: true`
   * plus an optional multi-language `message` (`en` mandatory, ≤ 200
   * characters per language) giving the reason. The badge keeps its transport
   * color with an orange dot overlay, and the tooltip shows the message.
   * Degraded is orthogonal to the transport — "which channel is in use" and
   * "is this the nominal state" are two different pieces of information — and
   * publishing an entry WITHOUT `degraded` explicitly clears a previously
   * published degraded state (back to nominal, no ghost orange dot).
   * @param {Array} transports - Entries: `{ external_id, transport, degraded, message }` (max 100).
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishTransports([{ external_id: gladys.externalId('plug:abc'), transport: 'local' }]);
   * @example
   * await gladys.publishTransports([
   *   {
   *     external_id: gladys.externalId('plug:abc'),
   *     transport: 'cloud',
   *     degraded: true,
   *     message: { en: 'Local session refused, falling back to cloud' },
   *   },
   * ]);
   */
  async publishTransports(transports) {
    if (!Array.isArray(transports)) {
      throw new Error('publishTransports: "transports" must be an array');
    }
    if (transports.length > MAX_TRANSPORTS_PER_REQUEST) {
      throw new Error(`publishTransports: maximum ${MAX_TRANSPORTS_PER_REQUEST} transports per request`);
    }
    const validTransports = Object.values(DEVICE_TRANSPORTS);
    const entries = transports.map((entry) => {
      const deviceExternalId = entry.external_id || entry.device_external_id;
      if (!deviceExternalId) {
        throw new Error('publishTransports: every entry must carry an "external_id"');
      }
      if (!validTransports.includes(entry.transport)) {
        throw new Error(`publishTransports: "transport" must be one of ${validTransports.join(', ')}`);
      }
      if (entry.degraded !== undefined && typeof entry.degraded !== 'boolean') {
        throw new Error('publishTransports: "degraded" must be a boolean');
      }
      if (entry.message !== undefined && entry.degraded !== true) {
        throw new Error('publishTransports: "message" is only taken into account when "degraded" is true');
      }
      const mapped = { device_external_id: deviceExternalId, transport: entry.transport };
      if (entry.degraded === true) {
        mapped.degraded = true;
        if (entry.message !== undefined) {
          const { message } = entry;
          // Only own enumerable properties survive the JSON serialization, so
          // an inherited "en" (Object.create) would reach Gladys as {} → 400.
          if (
            typeof message !== 'object' ||
            message === null ||
            Array.isArray(message) ||
            !Object.prototype.propertyIsEnumerable.call(message, 'en') ||
            typeof message.en !== 'string' ||
            !message.en
          ) {
            throw new Error('publishTransports: "message" must be a multi-language object with a mandatory "en" key');
          }
          for (const text of Object.values(message)) {
            if (typeof text !== 'string' || text.length > MAX_TRANSPORT_MESSAGE_LENGTH) {
              throw new Error(
                `publishTransports: every "message" language must be a string of at most ${MAX_TRANSPORT_MESSAGE_LENGTH} characters`,
              );
            }
          }
          mapped.message = message;
        }
      }
      return mapped;
    });
    return this.httpClient.post('/device/transport', { transports: entries });
  }

  /**
   * @description Fire a scene trigger declared in the manifest
   * `scene_triggers` field (contract "scene triggers and actions"): something
   * HAPPENED — a licence plate recognized, an object detected, a doorbell
   * pressed, a mail received. The core matches the flat `data` against the
   * filters the scene authors configured (equality and membership on the
   * declared `fields`, an empty filter is a wildcard) and starts the
   * matching scenes, exposing the declared `variables` to their actions as
   * `{{triggerEvent.data.<key>}}`; every other key is dropped, a declared key
   * absent from `data` is `null`. A resolved call means "accepted and
   * evaluated once", never "a scene ran": the integration knows nothing
   * about scenes. Doctrine: an event is a TRIGGER, never a state — a value
   * belongs to a device feature (publishState), a picture to the camera path
   * (publishCameraImage). One event per TRANSITION ("object entered", not
   * "object still there" every frame): the core admits 300 events per minute
   * per integration (429 beyond, a counter separate from the states'), sized
   * for a fleet, not for a stream. Errors are thrown as `GladysApiError`:
   * 404 on a key the manifest does not declare, 400 on a payload the core
   * refuses, 429 past the rate limit.
   * @param {string} key - Trigger key, as declared in the manifest.
   * @param {object} [data] - Flat details of the event: at most 30 keys, one
   * primitive per key (string ≤ 1000 characters, finite number, boolean or
   * null) — never a nested object or an array.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishSceneEvent('object_detected', {
   *   camera: gladys.externalId('cam:front'),
   *   label: 'person',
   *   zone: 'driveway',
   *   score: 0.92,
   * });
   */
  async publishSceneEvent(key, data = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('publishSceneEvent: "key" must be a non-empty string (a scene trigger declared in the manifest)');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('publishSceneEvent: "data" must be a flat object');
    }
    const keys = Object.keys(data);
    if (keys.length > MAX_SCENE_EVENT_DATA_KEYS) {
      throw new Error(`publishSceneEvent: maximum ${MAX_SCENE_EVENT_DATA_KEYS} keys per event`);
    }
    keys.forEach((dataKey) => {
      const value = data[dataKey];
      if (value === null || typeof value === 'boolean') {
        return;
      }
      if (typeof value === 'string') {
        if (value.length > MAX_SCENE_EVENT_STRING_LENGTH) {
          throw new Error(
            `publishSceneEvent: "data.${dataKey}" must be a string of at most ${MAX_SCENE_EVENT_STRING_LENGTH} characters`,
          );
        }
        return;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return;
      }
      throw new Error(
        `publishSceneEvent: "data.${dataKey}" must be a string, a finite number, a boolean or null (flat, no nested object or array)`,
      );
    });
    return this.httpClient.post('/scene/event', { key, data });
  }

  /**
   * @description Publish a message received in the external channel (contract
   * B.15, communication integrations): Gladys resolves the contact to the
   * linked user, then routes the message to the brain, the chat history and
   * the answering machinery — replies come back through the onSendMessage
   * handler. An incoming message carries the authority of the linked user, so
   * the contact MUST have linked their account first (linkContact): an unknown
   * contact is rejected with a 404 `GladysApiError`, and the integration
   * should then answer in the channel "account not linked, code required".
   * Bidirectional channels only: when the manifest declares
   * `messaging: { receive: false }` (send-only notification channel), Gladys
   * rejects the call with a 403 — a notification channel never talks to the
   * brain, guaranteed server-side.
   * @param {string} contactId - Id of the contact in the external channel.
   * @param {string} text - Text of the message (1-4096 characters).
   * @param {object} [options] - Options.
   * @param {string|Date} [options.createdAt] - ISO date of the message, for
   * messages received while the integration was offline.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.publishMessage('12345', 'Turn on the light');
   */
  async publishMessage(contactId, text, options = {}) {
    if (typeof contactId !== 'string' || contactId.length === 0) {
      throw new Error('publishMessage: "contactId" must be a non-empty string');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('publishMessage: "text" must be a non-empty string');
    }
    if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
      throw new Error(`publishMessage: maximum text length is ${MAX_MESSAGE_TEXT_LENGTH} characters`);
    }
    const body = { contact_id: contactId, text };
    if (options.createdAt !== undefined) {
      body.created_at = options.createdAt instanceof Date ? options.createdAt.toISOString() : options.createdAt;
    }
    return this.httpClient.post('/message', body);
  }

  /**
   * @description Link an external contact to a Gladys user (contract B.15,
   * bidirectional communication integrations — `messaging.receive: true`; a
   * send-only channel has no incoming path to relay a code, its users enter
   * their identity in the "My account" block of the Gladys UI instead, from
   * the manifest `contact_schema`). The code proves the consent: the user
   * generates it from the integration page in the Gladys UI (single use,
   * 15 minutes TTL), then sends it to the bot in the external channel — the
   * integration relays it here with the channel identity of the sender.
   * Resolves with the linked Gladys user, e.g. to greet them in the channel;
   * an invalid or expired code is rejected with a 404 `GladysApiError`.
   * @param {string} code - The short code typed by the contact in the channel.
   * @param {string} contactId - Id of the contact in the external channel.
   * @param {string} [contactName] - Display name of the contact, shown in the
   * Gladys UI next to the linked user.
   * @returns {Promise<object>} The linked user: `{ selector, first_name, language }`.
   * @example
   * const user = await gladys.linkContact('AB23CD45', '12345', 'John');
   */
  async linkContact(code, contactId, contactName) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('linkContact: "code" must be a non-empty string');
    }
    if (typeof contactId !== 'string' || contactId.length === 0) {
      throw new Error('linkContact: "contactId" must be a non-empty string');
    }
    const body = { code, contact_id: contactId };
    if (contactName !== undefined) {
      body.contact_name = contactName;
    }
    const { user } = await this.httpClient.post('/contact/link', body);
    return user;
  }

  /**
   * @description Fetch the contacts linked to the integration, with the
   * linked Gladys user of each one (contract B.15, communication
   * integrations) — e.g. to resynchronize the channel-side state after a
   * restart, or to detect that a contact was unlinked by the user from the
   * Gladys UI.
   * @returns {Promise<Array>} The contacts:
   * `[{ contact_id, contact_name, linked_at, user: { selector, first_name, language } }]`.
   * @example
   * const contacts = await gladys.getContacts();
   */
  async getContacts() {
    return this.httpClient.get('/contact');
  }

  /**
   * @description Fetch the users who ENABLED a calendar integration
   * (manifest `type: "calendar"`, contract capabilities/calendar-type.md),
   * with their `account_schema` values — secrets included: this is the
   * integration side, like getConfig(). Calendars are personal data: each
   * user enables the integration from the "My calendars" block of the
   * Gladys UI, and that consent is who the integration syncs. Read it on
   * every (re)connection and on onCalendarAccountUpdated. Any other
   * manifest type is rejected with a 403 `GladysApiError`.
   * @returns {Promise<Array>} The accounts:
   * `[{ user: { selector, first_name, language }, config }]`.
   * @example
   * const accounts = await gladys.getCalendarAccounts();
   */
  async getCalendarAccounts() {
    return this.httpClient.get('/calendar/account');
  }

  /**
   * @description Fetch the calendars the integration pushed (its own
   * calendars only), with the user-owned `sync` flag telling which to SKIP
   * (`sync: false`: the user said no, the core emptied its events and
   * refuses further pushes with a 403) — every enabled user's calendars when
   * `userSelector` is omitted (the startup resync in one call).
   * @param {string} [userSelector] - Restrict to one user's calendars.
   * @returns {Promise<Array>} The calendars:
   * `[{ user, external_id, selector, name, description, color, sync, shared }]`.
   * @example
   * const calendars = await gladys.getCalendars('john');
   */
  async getCalendars(userSelector) {
    if (userSelector === undefined) {
      return this.httpClient.get('/calendar');
    }
    if (typeof userSelector !== 'string' || userSelector.length === 0) {
      throw new Error('getCalendars: "userSelector" must be a non-empty string, or omitted for every user');
    }
    return this.httpClient.get(`/calendar?user=${encodeURIComponent(userSelector)}`);
  }

  /**
   * @description Publish (upsert by `external_id`) the calendars of ONE
   * enabled user (contract capabilities/calendar-type.md): the integration
   * syncs, the core stores — the calendars feed the calendar view, the
   * calendar scene triggers and the assistant exactly like the internal
   * CalDAV ones. Every `external_id` is USER-SCOPED: it must start with
   * `ext:<selector>:<user_selector>:` — build it with
   * `gladys.externalId(`${userSelector}:<provider id>`)` — so two household
   * members syncing the same provider-side id never collide (≤ 255
   * characters). `name` (1-100) is required; `description` (≤ 500) and
   * `color` (`#rrggbb`, an invalid one is dropped by the core, the default
   * applied on creation) are optional. The integration-owned fields (`name`,
   * `description`, `color`) are overwritten on every push; the user-owned
   * ones (`sync`, `shared`, `selector`) are never touched — a pushed calendar
   * starts private (`shared: false`): it reaches the household and the
   * scenes only once the user shares it. At most 50 calendars per user,
   * counting the existing ones (400 beyond); an unknown or not-enabled user
   * is a 404; calendar writes are rate-limited to 30 per minute per
   * integration (429 beyond). Validated SDK-side before any request.
   * @param {string} userSelector - Selector of the enabled user (getCalendarAccounts).
   * @param {Array} calendars - `[{ external_id, name, description?, color? }]`.
   * @returns {Promise<object>} `{ success, created, updated }`.
   * @example
   * await gladys.publishCalendars('john', [
   *   { external_id: gladys.externalId('john:primary'), name: 'Personal', color: '#3174ad' },
   * ]);
   */
  async publishCalendars(userSelector, calendars) {
    if (typeof userSelector !== 'string' || userSelector.length === 0) {
      throw new Error(
        'publishCalendars: "userSelector" must be a non-empty string (an enabled user, see getCalendarAccounts)',
      );
    }
    if (!Array.isArray(calendars)) {
      throw new Error('publishCalendars: "calendars" must be an array');
    }
    if (calendars.length > MAX_CALENDARS_PER_USER) {
      throw new Error(`publishCalendars: maximum ${MAX_CALENDARS_PER_USER} calendars per user`);
    }
    const prefix = this.externalId(`${userSelector}:`);
    const seen = new Set();
    const mapped = calendars.map((calendar, index) => {
      const path = `publishCalendars: "calendars[${index}]`;
      if (!isPlainObject(calendar)) {
        throw new Error(`${path}" must be an object`);
      }
      checkUserScopedExternalId(calendar.external_id, prefix, seen, path);
      if (
        typeof calendar.name !== 'string' ||
        calendar.name.length === 0 ||
        calendar.name.length > MAX_CALENDAR_NAME_LENGTH
      ) {
        throw new Error(`${path}.name" must be a string of 1-${MAX_CALENDAR_NAME_LENGTH} characters`);
      }
      const entry = { external_id: calendar.external_id, name: calendar.name };
      copyOptionalText(calendar, entry, 'description', MAX_CALENDAR_DESCRIPTION_LENGTH, path);
      if (calendar.color !== undefined && calendar.color !== null) {
        if (typeof calendar.color !== 'string') {
          throw new Error(`${path}.color" must be a string like "#3174ad"`);
        }
        entry.color = calendar.color;
      }
      return entry;
    });
    return this.httpClient.post('/calendar', { user: userSelector, calendars: mapped });
  }

  /**
   * @description Destroy one of the integration's calendars and its events
   * (contract capabilities/calendar-type.md) — how a provider-side deletion
   * propagates. Its own calendars only: another integration's, or an
   * unknown one, is a 404 `GladysApiError`. Counts as a calendar write (30
   * per minute per integration).
   * @param {string} externalId - The calendar external_id.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.deleteCalendar(gladys.externalId('john:primary'));
   */
  async deleteCalendar(externalId) {
    if (typeof externalId !== 'string' || externalId.length === 0) {
      throw new Error('deleteCalendar: "externalId" must be a non-empty string (a calendar external_id)');
    }
    return this.httpClient.delete(`/calendar?external_id=${encodeURIComponent(externalId)}`);
  }

  /**
   * @description Publish (upsert by `external_id`) a batch of events in one
   * of the integration's calendars (contract capabilities/calendar-type.md),
   * at most 500 per call. Every event `external_id` carries the same
   * user-scoped prefix as its calendar (`ext:<selector>:<user_selector>:` +
   * the provider UID, ≤ 255 characters) and is a stable per-user identity
   * INDEPENDENT of the calendar: an event republished under another calendar
   * of the same user is moved, not duplicated. `name` (1-200) and `start`
   * are required; `end` (≥ `start`, a timed event without `end` is stored
   * with zero duration), `full_day`, `location` (≤ 500), `description`
   * (≤ 1000) and `url` (http(s), ≤ 500) are optional. A `full_day` event is
   * interpreted by CALENDAR DATE, `end` exclusive (the iCalendar convention):
   * pass the dates as written by the provider (`'2026-08-15'`, or the date
   * part of an ISO datetime whatever its offset — a Date would be converted
   * to UTC first), the core stores them at the midnights of the instance
   * timezone; a missing `end` covers the start day. Recurrences are expanded
   * by the integration (the core stores occurrences only): a bounded
   * horizon, 12 months ahead, keeps the 10 000 events per calendar cap away.
   *
   * With `window` (`{ from, to }`), the integration's events overlapping the
   * window — `start < to` and (`end > from` or `start >= from`) — and absent
   * from the list are DELETED: a provider-side deletion propagates by simply
   * republishing the window, idempotently; events created by hand in Gladys
   * are never pruned; every pushed event must overlap the window (400
   * otherwise). ONE window, ONE request: a window request replaces the
   * window's content with its own list, so more than 500 events in a range
   * means disjoint sub-windows, one request each, a boundary-straddling
   * event included in every request whose sub-window it overlaps. Without
   * `window`: pure upsert, no deletion. A calendar whose user disabled the
   * integration is a 404, a `sync: false` calendar a 403; calendar writes
   * are rate-limited to 30 per minute per integration (429 beyond).
   * Validated SDK-side before any request.
   * @param {string} calendarExternalId - The calendar external_id.
   * @param {Array} events - `[{ external_id, name, start, end?, full_day?, location?, description?, url? }]`.
   * @param {object} [window] - `{ from, to }` (ISO strings or Dates, `from` < `to`): prune the window.
   * @returns {Promise<object>} `{ success, created, updated, deleted }`.
   * @example
   * await gladys.publishCalendarEvents(
   *   gladys.externalId('john:primary'),
   *   [
   *     { external_id: gladys.externalId('john:8f3a@google.com'), name: 'Dentist', start: '2026-08-14T09:00:00.000Z', end: '2026-08-14T09:30:00.000Z' },
   *     { external_id: gladys.externalId('john:holiday-20260815'), name: 'Assomption', start: '2026-08-15', end: '2026-08-16', full_day: true },
   *   ],
   *   { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
   * );
   */
  async publishCalendarEvents(calendarExternalId, events, window) {
    const integrationPrefix = this.externalId('');
    const userSelector =
      typeof calendarExternalId === 'string' && calendarExternalId.startsWith(integrationPrefix)
        ? calendarExternalId.slice(integrationPrefix.length).split(':')[0]
        : '';
    if (userSelector.length === 0 || calendarExternalId.length <= integrationPrefix.length + userSelector.length + 1) {
      throw new Error(
        `publishCalendarEvents: "calendarExternalId" must be a calendar external_id of the integration ("${integrationPrefix}<user_selector>:<id>")`,
      );
    }
    if (!Array.isArray(events)) {
      throw new Error('publishCalendarEvents: "events" must be an array');
    }
    if (events.length > MAX_CALENDAR_EVENTS_PER_REQUEST) {
      throw new Error(`publishCalendarEvents: maximum ${MAX_CALENDAR_EVENTS_PER_REQUEST} events per request`);
    }
    const body = { calendar_external_id: calendarExternalId, events: [] };
    if (window !== undefined) {
      if (!isPlainObject(window)) {
        throw new Error('publishCalendarEvents: "window" must be an object { from, to }');
      }
      body.window = {
        from: toDateString(window.from, 'publishCalendarEvents: "window.from"'),
        to: toDateString(window.to, 'publishCalendarEvents: "window.to"'),
      };
      if (Date.parse(body.window.from) >= Date.parse(body.window.to)) {
        throw new Error('publishCalendarEvents: "window.from" must be before "window.to"');
      }
    }
    const prefix = `${integrationPrefix}${userSelector}:`;
    const seen = new Set();
    body.events = events.map((event, index) => {
      const path = `publishCalendarEvents: "events[${index}]`;
      if (!isPlainObject(event)) {
        throw new Error(`${path}" must be an object`);
      }
      checkUserScopedExternalId(event.external_id, prefix, seen, path);
      if (
        typeof event.name !== 'string' ||
        event.name.length === 0 ||
        event.name.length > MAX_CALENDAR_EVENT_NAME_LENGTH
      ) {
        throw new Error(`${path}.name" must be a string of 1-${MAX_CALENDAR_EVENT_NAME_LENGTH} characters`);
      }
      if (event.full_day !== undefined && typeof event.full_day !== 'boolean') {
        throw new Error(`${path}.full_day" must be a boolean`);
      }
      const entry = {
        external_id: event.external_id,
        name: event.name,
        start: toDateString(event.start, `${path}.start"`),
      };
      if (event.end !== undefined && event.end !== null) {
        entry.end = toDateString(event.end, `${path}.end"`);
      }
      if (event.full_day === true) {
        entry.full_day = true;
        // a full-day event is read by calendar date — what the provider wrote,
        // never an instant converted between timezones — so its dates are
        // checked, and ordered, on their YYYY-MM-DD part
        [entry.start, entry.end].forEach((date, dateIndex) => {
          if (date !== undefined && !isCalendarDate(date.slice(0, 10))) {
            throw new Error(
              `${path}.${dateIndex === 0 ? 'start' : 'end'}" must be a calendar date (YYYY-MM-DD) on a full-day event`,
            );
          }
        });
        if (entry.end !== undefined && entry.end.slice(0, 10) < entry.start.slice(0, 10)) {
          throw new Error(`${path}.end" must not be before "start"`);
        }
      } else if (entry.end !== undefined && Date.parse(entry.end) < Date.parse(entry.start)) {
        throw new Error(`${path}.end" must not be before "start"`);
      }
      copyOptionalText(event, entry, 'location', MAX_CALENDAR_EVENT_LOCATION_LENGTH, path);
      copyOptionalText(event, entry, 'description', MAX_CALENDAR_EVENT_DESCRIPTION_LENGTH, path);
      if (event.url !== undefined && event.url !== null) {
        if (
          typeof event.url !== 'string' ||
          event.url.length > MAX_CALENDAR_EVENT_URL_LENGTH ||
          !CALENDAR_EVENT_URL_REGEX.test(event.url)
        ) {
          throw new Error(`${path}.url" must be an http(s) URL of at most ${MAX_CALENDAR_EVENT_URL_LENGTH} characters`);
        }
        entry.url = event.url;
      }
      return entry;
    });
    return this.httpClient.post('/calendar/event', body);
  }

  /**
   * @description Publish (upsert by `starts_at`) the entries of a tariff
   * calendar declared in the manifest `energy_contracts.calendars` (contract
   * capabilities/energy-contracts.md, section 2): the dated values the core
   * rule engine reads to price the users' contracts — day colours, public
   * holidays, critical peak days (a string `value` within the declared
   * `values` enum) or spot prices per kWh (a numeric `price`, in the
   * declared `currency`). Each entry carries `starts_at` (ISO date or Date,
   * aligned on the calendar granularity: a local midnight of the calendar
   * timezone for a daily calendar, a 30- or 15-minute slot of its local
   * clock otherwise) or, on a daily calendar only, `date` (`YYYY-MM-DD`, the
   * local date), and exactly one of `value` or `price`; at most 2,000
   * entries per call, from 5 years back to 7 days ahead (400 otherwise).
   * Calendar keys are global per Gladys instance and owned by the first
   * installed integration declaring them: an undeclared or foreign key is a
   * 403 `GladysApiError`. A changed value already used by a computed cost
   * (a corrected colour, a final price replacing a provisional one) queues
   * a bounded recalculation core-side (1 per calendar per 10 minutes).
   * Validated SDK-side before any request.
   * @param {string} key - Calendar key, as declared in the manifest.
   * @param {Array} entries - `[{ starts_at | date, value | price, currency? }]`.
   * @returns {Promise<object>} `{ success, count, changed_from }` —
   * `changed_from` the earliest instant whose value changed (ISO), `null` when none did.
   * @example
   * await gladys.publishEnergyCalendar('hq-critical-peaks', [{ date: '2026-01-12', value: 'critical-peak' }]);
   * @example
   * await gladys.publishEnergyCalendar('spot-fi', slots.map((slot) => ({ starts_at: slot.start, price: slot.eurPerKwh })));
   */
  async publishEnergyCalendar(key, entries) {
    checkEnergyCalendarKey(key, 'publishEnergyCalendar');
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('publishEnergyCalendar: "entries" must be a non-empty array');
    }
    if (entries.length > MAX_ENERGY_CALENDAR_ENTRIES_PER_REQUEST) {
      throw new Error(`publishEnergyCalendar: maximum ${MAX_ENERGY_CALENDAR_ENTRIES_PER_REQUEST} entries per request`);
    }
    const mapped = entries.map((entry, index) => {
      const path = `publishEnergyCalendar: "entries[${index}]`;
      if (!isPlainObject(entry)) {
        throw new Error(`${path}" must be an object`);
      }
      const hasStartsAt = entry.starts_at !== undefined && entry.starts_at !== null;
      const hasDate = entry.date !== undefined && entry.date !== null;
      if (hasStartsAt === hasDate) {
        throw new Error(
          `${path}" must carry exactly one of "starts_at" (ISO date) or "date" (YYYY-MM-DD, daily calendars)`,
        );
      }
      const hasValue = entry.value !== undefined && entry.value !== null;
      const hasPrice = entry.price !== undefined && entry.price !== null;
      if (hasValue === hasPrice) {
        throw new Error(`${path}" must carry exactly one of "value" (a declared string value) or "price" (per kWh)`);
      }
      const result = {};
      if (hasDate) {
        if (typeof entry.date !== 'string' || !isCalendarDate(entry.date)) {
          throw new Error(`${path}.date" must be a YYYY-MM-DD date that exists`);
        }
        result.date = entry.date;
      } else {
        result.starts_at = toDateString(entry.starts_at, `${path}.starts_at"`);
      }
      if (hasValue) {
        if (typeof entry.value !== 'string' || entry.value.length === 0 || entry.value.length > 64) {
          throw new Error(`${path}.value" must be a string of 1-64 characters (one of the declared values)`);
        }
        result.value = entry.value;
      } else {
        if (typeof entry.price !== 'number' || !Number.isFinite(entry.price)) {
          throw new Error(`${path}.price" must be a finite number (per kWh, in the calendar currency)`);
        }
        result.price = entry.price;
        if (entry.currency !== undefined && entry.currency !== null) {
          if (typeof entry.currency !== 'string') {
            throw new Error(`${path}.currency" must be an ISO 4217 code`);
          }
          result.currency = entry.currency;
        }
      }
      return result;
    });
    return this.httpClient.post('/energy/calendar', { calendar_key: key, entries: mapped });
  }

  /**
   * @description Read back the entries of a tariff calendar the integration
   * declares AND owns (contract capabilities/energy-contracts.md, section 2)
   * — resume after a restart: know how far the core is fed before fetching
   * at the provider. Oldest first over `from`/`to`; without a window, the
   * `limit` last entries. A key declared by another integration (or by
   * none) is a 403 `GladysApiError`.
   * @param {string} key - Calendar key, as declared in the manifest.
   * @param {object} [options] - Options.
   * @param {string|Date} [options.from] - Start of the window (inclusive).
   * @param {string|Date} [options.to] - End of the window (inclusive).
   * @param {number} [options.limit] - Maximum number of entries (the last ones without a window).
   * @returns {Promise<Array>} The entries: `[{ starts_at, value }]`, `value`
   * the string or the price.
   * @example
   * const [last] = await gladys.getEnergyCalendar('spot-fi', { limit: 1 });
   */
  async getEnergyCalendar(key, options = {}) {
    checkEnergyCalendarKey(key, 'getEnergyCalendar');
    const query = new URLSearchParams();
    if (options.from !== undefined) {
      query.set('from', toDateString(options.from, 'getEnergyCalendar: "from"'));
    }
    if (options.to !== undefined) {
      query.set('to', toDateString(options.to, 'getEnergyCalendar: "to"'));
    }
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error('getEnergyCalendar: "limit" must be a positive integer');
      }
      query.set('limit', String(options.limit));
    }
    const search = query.toString();
    return this.httpClient.get(`/energy/calendar/${encodeURIComponent(key)}${search.length > 0 ? `?${search}` : ''}`);
  }

  /**
   * @description Fetch the users' energy contracts referencing a template of
   * this integration (contract capabilities/energy-contracts.md, section 2):
   * identity, inputs, validity, timezone, currency, billing period and
   * status — never the meter nor the consumption. A `delegated` contract is
   * one onEnergyPrice prices; an `orphaned` one lost its provider.
   * @returns {Promise<Array>} The contracts: `[{ id, template_key, template_version,
   * pricing_mode, inputs, valid_from, valid_to, timezone, currency, billing_period_start_day, status }]`.
   * @example
   * const contracts = await gladys.getEnergyContracts();
   */
  async getEnergyContracts() {
    return this.httpClient.get('/energy/contract');
  }

  /**
   * @description Publish dated consumption intervals on a 30-minute or daily
   * consumption feature of this integration (contract host-api-endpoints.md)
   * — for the suppliers whose readings arrive after the fact (Hydro-Québec,
   * every portal serving yesterday's readings): the index path is a LIVE
   * pipeline, an index published a day late collapses a whole day into one
   * half-hour and a daily total never falls in a critical-peak slot. Such an
   * integration publishes no index but a consumption feature it feeds itself
   * — `energy-sensor` / `thirty-minutes-consumption` (what a time-of-use or
   * critical-peak tariff needs) or `daily-consumption` (enough for a flat or
   * a tiered tariff) — and the core derives its cost feature, attaches it to
   * the main electric meter and prices it like any consumption. Each
   * interval carries `starts_at` (ISO date or Date, aligned on a 30-minute
   * slot of the Gladys timezone — a local midnight for a daily feature) or,
   * on a daily feature only, `date` (`YYYY-MM-DD`, the local date), and
   * `kwh` (finite, ≥ 0; split an hourly reading into two equal half-hours);
   * at most 2,000 intervals per call, elapsed and at most 5 years old (400
   * otherwise). The states are upserted by instant — a republication or a
   * corrected reading replaces the stored value, never duplicates it, an
   * unchanged value writes nothing, the last value given for an instant wins
   * within a batch — and a changed value queues a bounded cost recalculation
   * of the feature's root meter from the earliest change (1 per meter per 10
   * minutes): there is no dated "recalculate from", the publication carries
   * the date. A feature of a device the user has not created yet is a 404
   * `GladysApiError` (retry once it exists), a feature outside the
   * integration or that is not a consumption, or a consumption the core
   * derives from a published index, a 400. These states never go through
   * `POST /state`. The shapes are validated SDK-side before any request; the
   * alignment on the Gladys clock is the core's.
   * @param {string} deviceFeatureExternalId - External id of the consumption feature.
   * @param {Array} intervals - `[{ starts_at | date, kwh }]`.
   * @returns {Promise<object>} `{ success, count, changed_from }` — `count`
   * the number of distinct instants, `changed_from` the instant of the
   * earliest state whose value changed (ISO), `null` when none did.
   * @example
   * await gladys.publishEnergyConsumption(ids.feature('consumption'), [
   *   { starts_at: '2026-01-12T05:00:00Z', kwh: 0.42 },
   *   { starts_at: '2026-01-12T05:30:00Z', kwh: 0.38 },
   * ]);
   * @example
   * await gladys.publishEnergyConsumption(ids.feature('daily'), [{ date: '2026-01-12', kwh: 18.4 }]);
   */
  async publishEnergyConsumption(deviceFeatureExternalId, intervals) {
    const prefix = `ext:${this.selector}:`;
    if (
      typeof deviceFeatureExternalId !== 'string' ||
      !deviceFeatureExternalId.startsWith(prefix) ||
      deviceFeatureExternalId.length <= prefix.length
    ) {
      throw new Error(
        `publishEnergyConsumption: "deviceFeatureExternalId" must start with "${prefix}" (a consumption feature of this integration)`,
      );
    }
    if (!Array.isArray(intervals) || intervals.length === 0) {
      throw new Error('publishEnergyConsumption: "intervals" must be a non-empty array');
    }
    if (intervals.length > MAX_ENERGY_CONSUMPTION_INTERVALS_PER_REQUEST) {
      throw new Error(
        `publishEnergyConsumption: maximum ${MAX_ENERGY_CONSUMPTION_INTERVALS_PER_REQUEST} intervals per request`,
      );
    }
    const mapped = intervals.map((interval, index) => {
      const path = `publishEnergyConsumption: "intervals[${index}]`;
      if (!isPlainObject(interval)) {
        throw new Error(`${path}" must be an object`);
      }
      const hasStartsAt = interval.starts_at !== undefined && interval.starts_at !== null;
      const hasDate = interval.date !== undefined && interval.date !== null;
      if (hasStartsAt === hasDate) {
        throw new Error(
          `${path}" must carry exactly one of "starts_at" (ISO date) or "date" (YYYY-MM-DD, daily features)`,
        );
      }
      if (typeof interval.kwh !== 'number' || !Number.isFinite(interval.kwh) || interval.kwh < 0) {
        throw new Error(`${path}.kwh" must be a finite number >= 0`);
      }
      const result = {};
      if (hasDate) {
        if (typeof interval.date !== 'string' || !isCalendarDate(interval.date)) {
          throw new Error(`${path}.date" must be a YYYY-MM-DD date that exists`);
        }
        result.date = interval.date;
      } else {
        result.starts_at = toDateString(interval.starts_at, `${path}.starts_at"`);
      }
      result.kwh = interval.kwh;
      return result;
    });
    return this.httpClient.post('/energy/consumption', {
      device_feature_external_id: deviceFeatureExternalId,
      intervals: mapped,
    });
  }

  /**
   * @description Fetch the Gladys Plus webhook state of the integration
   * (contract B.17): whether the relay is available (the user linked Gladys
   * Plus and pasted their Open API key in the Configuration screen), and the
   * ready-to-register public URL of each webhook declared in the manifest.
   * The Netatmo pattern: (re)register the URLs at the third party on every
   * successful connection to the service, best effort. `available: false`
   * (no Gladys Plus) → degrade to poll only. The `webhook-updated` event
   * (onWebhookUpdated) fires when this state changes.
   * @returns {Promise<object>} `{ available, webhooks: [{ key, mode, url }] }`.
   * @example
   * const { available, webhooks } = await gladys.getWebhooks();
   */
  async getWebhooks() {
    return this.httpClient.get('/webhook');
  }

  /**
   * @description Fetch the integration configuration (all values, secrets
   * included), and refresh `gladys.config`.
   * @returns {Promise<object>} The configuration values.
   * @example
   * const config = await gladys.getConfig();
   */
  async getConfig() {
    const { config } = await this.httpClient.get('/config');
    this.config = config;
    return config;
  }

  /**
   * @description Save configuration values (partial merge). Keys outside the
   * manifest config_schema are free internal storage, never shown in the UI.
   * Keys of `section` fields (presentational intro blocks, no stored value)
   * are rejected by the host API. A `source: "houses"` field is chosen by
   * the user: unless the manifest declares `location: true`, it only takes
   * its stored value back unchanged (a no-op) — any other value is a 403.
   * @param {object} partialConfig - Keys/values to merge.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.setConfig({ pairing_state: 'done' });
   */
  async setConfig(partialConfig) {
    return this.httpClient.post('/config', { config: partialConfig });
  }

  /**
   * @description Fetch the Gladys version and the integration service status.
   * @returns {Promise<object>} `{ gladys_version, service }`.
   * @example
   * const status = await gladys.getStatus();
   */
  async getStatus() {
    return this.httpClient.get('/status');
  }

  /**
   * @description Publish the application-level connection status of the
   * integration (contract C.3), shown in the Configuration screen of the
   * Gladys UI. Distinct from the container state machine: a cloud integration
   * can be RUNNING and still disconnected from its third-party service (e.g.
   * expired OAuth token) — without this channel it would be silently broken.
   * @param {boolean} connected - Whether the integration is connected to its service.
   * @param {object} [message] - Optional multi-language message, e.g.
   * `{ en: 'Token expired, please reconnect.', fr: 'Token expiré.' }`.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.setConnectionStatus(false, { en: 'Token expired, please reconnect.' });
   */
  async setConnectionStatus(connected, message) {
    const body = { connected };
    if (message !== undefined) {
      body.message = message;
    }
    return this.httpClient.post('/connection_status', body);
  }

  /**
   * @description Fetch the sub-containers declared in the manifest: their
   * Docker status, desired state, assigned host ports and, per requested
   * hardware class, the granted/available flags (contract C.3) — how the
   * integration knows what to put in its generated configs. Each port carries
   * `{ container_port, protocol, host_port, label, name, browsable }`;
   * `host_port` is `null` while Gladys has not allocated one yet, `name` is the
   * optional manifest identifier referenced by the `{{port:<name>}}`
   * placeholder of the section texts (`null` when undeclared), and
   * `browsable: false` marks a port that serves no web UI (a WebSocket
   * endpoint for devices, say).
   * `status` reads `pulling` while the image of a `manual` entry is
   * downloaded by its first start, with `pull: { progress, detail }`
   * (`progress` 0-100, or `null` until a layer size is known); `last_error`
   * holds the code of the last failed asynchronous start
   * (`UNABLE_TO_PULL_IMAGE`, `UNABLE_TO_START_CONTAINER`), `null` otherwise.
   * @returns {Promise<Array>} The containers; empty if none is declared.
   * @example
   * const containers = await gladys.getContainers();
   */
  async getContainers() {
    const { containers } = await this.httpClient.get('/container');
    return containers;
  }

  /**
   * @description Create (if needed) and start a sub-container declared in the
   * manifest — typically after generating its config files in `/data`. The
   * container enters the desired state "running" (restarted by the supervisor
   * if it crashes). The optional `env` is merged over the manifest env (keys
   * `GLADYS_*` are rejected); when it differs from the existing container env,
   * the supervisor recreates the container before starting it. Resolving
   * always means the container is up, so `await startContainer('mqtt')` then
   * connecting to it stays safe: when the image is not on the disk yet (first
   * start of a `start: "manual"` entry, whose image the install does not
   * pull), the core answers 202 `{ status: 'pulling' }` at once and downloads
   * it in the background, and the SDK polls getContainers() every 2 s until
   * the entry is `running` (resolves `{ success: true, status: 'running' }`)
   * or not starting anymore (rejects). An image can weigh several GB: hence
   * the generous default timeout, and `onProgress` to relay the download.
   * @param {string} name - Container name, as declared in the manifest.
   * @param {object} [options] - Options.
   * @param {object} [options.env] - Runtime-computed environment variables.
   * @param {number} [options.timeoutMs] - How long to wait for a download
   * (default: 30 minutes); rejects with code `CONTAINER_START_TIMEOUT` after
   * it (the core keeps downloading: a later start joins it).
   * @param {Function} [options.onProgress] - Called with the `pull` object
   * (`{ progress: 0-100 | null, detail }`) at each poll of a download.
   * @returns {Promise<object>} `{ success }` when the core started it right
   * away, `{ success, status: 'running' }` after a download. Rejects with an
   * Error whose `code` is the entry's `last_error` (`UNABLE_TO_PULL_IMAGE`,
   * `UNABLE_TO_START_CONTAINER`), `CONTAINER_NOT_STARTED` when the download
   * ended without a running container (stopped meanwhile, Gladys restarted)
   * or `CONTAINER_START_TIMEOUT`.
   * @example
   * await gladys.startContainer('mqtt', { env: { MQTT_PASSWORD: password } });
   */
  async startContainer(name, options = {}) {
    const body = options.env === undefined ? {} : { env: options.env };
    const response = await this.httpClient.post(`/container/${encodeURIComponent(name)}/start`, body);
    return this._waitForContainerPull(name, response, options);
  }

  /**
   * @description Stop a sub-container and clear its desired state: the
   * supervisor will not restart it. It also aborts a download of its image
   * in progress: a startContainer waiting for it then rejects with
   * `CONTAINER_NOT_STARTED`.
   * @param {string} name - Container name, as declared in the manifest.
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.stopContainer('mqtt');
   */
  async stopContainer(name) {
    return this.httpClient.post(`/container/${encodeURIComponent(name)}/stop`, {});
  }

  /**
   * @description Restart a sub-container — typically after rewriting one of
   * its config files through `/data` to apply it. Like startContainer, it
   * resolves once the container is up, waiting for the download of its image
   * when the core answers 202 `{ status: 'pulling' }`.
   * @param {string} name - Container name, as declared in the manifest.
   * @param {object} [options] - Options.
   * @param {number} [options.timeoutMs] - How long to wait for a download (default: 30 minutes).
   * @param {Function} [options.onProgress] - Called with the `pull` object at each poll of a download.
   * @returns {Promise<object>} `{ success }`, or `{ success, status: 'running' }`
   * after a download; rejects like startContainer.
   * @example
   * await gladys.restartContainer('frigate');
   */
  async restartContainer(name, options = {}) {
    const response = await this.httpClient.post(`/container/${encodeURIComponent(name)}/restart`, {});
    return this._waitForContainerPull(name, response, options);
  }

  /**
   * @description Turn the 202 `{ status: 'pulling' }` answer of a start or
   * restart back into "the container is up": poll GET /container until the
   * entry runs, and reject when it stops pulling without running. Any other
   * answer is returned as is (the core started the container synchronously).
   * @param {string} name - Container name.
   * @param {object} response - Answer of POST /container/:name/start|restart.
   * @param {object} options - `{ timeoutMs, onProgress }`.
   * @returns {Promise<object>} The answer, or `{ success: true, status: 'running' }`.
   * @example
   * return this._waitForContainerPull('frigate', response, options);
   */
  async _waitForContainerPull(name, response, options) {
    if (!response || response.status !== 'pulling') {
      return response;
    }
    const { timeoutMs = DEFAULT_CONTAINER_PULL_TIMEOUT, onProgress } = options;
    const pollIntervalMs = this.containerPullPollInterval;
    const deadline = Date.now() + timeoutMs;
    const fail = (code, message) => {
      const error = new Error(message);
      error.code = code;
      error.container = name;
      return error;
    };
    for (;;) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));
      });
      const containers = await this.getContainers();
      const container = containers.find((entry) => entry.name === name);
      if (container && container.status === 'running') {
        return { success: true, status: 'running' };
      }
      if (!container || container.status !== 'pulling') {
        if (container && container.last_error) {
          throw fail(container.last_error, `sub-container ${name} could not start (${container.last_error})`);
        }
        throw fail('CONTAINER_NOT_STARTED', `sub-container ${name} stopped pulling without running`);
      }
      if (onProgress) {
        try {
          onProgress(container.pull || { progress: null, detail: null });
        } catch (e) {
          this.logger.warn(`startContainer(${name}): the onProgress callback threw: ${describeError(e)}`);
        }
      }
      if (Date.now() >= deadline) {
        throw fail(
          'CONTAINER_START_TIMEOUT',
          `sub-container ${name} still downloading its image after ${Math.round(timeoutMs / 1000)} s`,
        );
      }
    }
  }

  /**
   * @description Run an on-demand mediated network scan (contract B.16).
   * Bridge containers never receive LAN broadcast/mDNS/SSDP traffic, so the
   * core — which runs on the host network — captures what the manifest
   * `network_discovery` field declares and returns the RAW results: the core
   * captures (network position), the integration interprets (protocol
   * knowledge). Parse the results yourself (e.g. decode the Tuya
   * `payload_base64` announcements), join the devices through unicast (which
   * crosses the NAT), then publish them with publishDiscoveredDevices.
   * Undeclared type/ports are rejected with a 403.
   *
   * 'udp-active-broadcast' is the query/response variant (TP-Link Kasa style):
   * the integration forges the discovery request (`payload`, the protocol
   * crypto stays on the integration side), the core broadcasts it on `port`
   * and relays the raw unicast replies in the same shape as 'udp-broadcast'.
   * Guardrails enforced by the core: broadcast only (never a chosen unicast
   * target), port declared in the manifest, payload of at most 512 decoded
   * bytes, 1 scan per 10 seconds per integration (429 otherwise).
   * @param {string} type - Declared capture type: 'udp-broadcast' |
   * 'udp-active-broadcast' | 'mdns' | 'ssdp'.
   * @param {object} [options] - Options.
   * @param {number} [options.timeoutSeconds] - Scan duration in seconds (1-30).
   * @param {number} [options.port] - 'udp-active-broadcast' only (required): destination
   * UDP port of the broadcast, among the manifest-declared ports.
   * @param {Buffer|string} [options.payload] - 'udp-active-broadcast' only (required):
   * discovery request to broadcast, as a Buffer or an already-base64-encoded
   * string (≤ 512 decoded bytes).
   * @returns {Promise<Array>} Raw results — 'udp-broadcast' and
   * 'udp-active-broadcast': `[{ source_ip, source_port, payload_base64 }]`;
   * 'mdns': `[{ name, host, addresses, port, txt }]` (every declared mdns
   * entry is browsed, results merged; `txt` holds the raw TXT entries,
   * parseMdnsTxt turns them into an object); 'ssdp':
   * `[{ source_ip, source_mac?, source_port, headers }]` — `headers` is the
   * raw response text, `source_mac` a best-effort ARP-table lookup by the
   * core (its absence is ordinary, not an error).
   * @example
   * const results = await gladys.scanNetwork('udp-broadcast', { timeoutSeconds: 10 });
   * @example
   * const replies = await gladys.scanNetwork('udp-active-broadcast', {
   *   port: 9999,
   *   payload: encryptKasaDiscoveryRequest(), // your protocol code, returns a Buffer
   *   timeoutSeconds: 5,
   * });
   */
  async scanNetwork(type, options = {}) {
    const body = { type };
    if (type === 'udp-active-broadcast') {
      if (!Number.isInteger(options.port)) {
        throw new Error('scanNetwork: "port" (a manifest-declared port) is required for a udp-active-broadcast scan');
      }
      let payloadBuffer;
      if (Buffer.isBuffer(options.payload)) {
        payloadBuffer = options.payload;
      } else if (typeof options.payload === 'string' && options.payload.length > 0) {
        payloadBuffer = Buffer.from(options.payload, 'base64');
      } else {
        throw new Error(
          'scanNetwork: "payload" (a Buffer or a base64 string) is required for a udp-active-broadcast scan',
        );
      }
      if (payloadBuffer.length === 0) {
        throw new Error('scanNetwork: "payload" must not be empty');
      }
      if (payloadBuffer.length > MAX_ACTIVE_SCAN_PAYLOAD_SIZE) {
        throw new Error(`scanNetwork: maximum payload size is ${MAX_ACTIVE_SCAN_PAYLOAD_SIZE} decoded bytes`);
      }
      body.port = options.port;
      body.payload_base64 = payloadBuffer.toString('base64');
    }
    if (options.timeoutSeconds !== undefined) {
      body.timeout_seconds = options.timeoutSeconds;
    }
    return this.httpClient.post('/network_discovery/scan', body);
  }

  /**
   * @description Send a Wake-on-LAN magic packet from the Gladys core network
   * namespace (contract C.3). Bridge containers cannot reach the LAN in
   * broadcast, so the core — which runs on the host network — emits the
   * standard fixed magic packet (6 × 0xFF followed by the target MAC repeated
   * 16 times) on behalf of the integration: the payload is built by the core,
   * never by the integration, so this is not a general UDP proxy. Requires
   * `network_wake: true` in the manifest (shown on the install screen) — an
   * undeclared access is rejected with a 403. Rate-limited by the core to
   * 1 wake per 2 seconds per integration (429 beyond): enough for the usual
   * "retry until the device answers" loop. A resolved call means the packet
   * was emitted by Gladys, not that the target device actually woke up —
   * poll the device to confirm.
   * @param {string} mac - Target MAC address (`64:e4:d5:b4:12:66`,
   * `64-e4-d5-b4-12-66` or `64E4D5B41266`).
   * @param {object} [options] - Options.
   * @param {string} [options.address] - Destination IPv4 address (default:
   * 255.255.255.255, the limited broadcast — use the subnet broadcast, e.g.
   * `192.168.1.255`, when the device ignores the limited one).
   * @param {number} [options.port] - Destination UDP port (default: 9).
   * @param {number} [options.sourcePort] - Source UDP port (default: 0, an
   * ephemeral port chosen by the operating system).
   * @returns {Promise<object>} `{ success }`.
   * @example
   * await gladys.wakeOnLan('64:e4:d5:b4:12:66');
   */
  async wakeOnLan(mac, options = {}) {
    if (typeof mac !== 'string' || !/^[0-9a-fA-F]{12}$/.test(mac.replace(/[:-]/g, ''))) {
      throw new Error('wakeOnLan: "mac" must be a MAC address like "64:e4:d5:b4:12:66"');
    }
    if (options.address !== undefined && !net.isIPv4(options.address)) {
      throw new Error('wakeOnLan: "address" must be an IPv4 address (e.g. "192.168.1.255")');
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
      throw new Error('wakeOnLan: "port" must be an integer between 1 and 65535');
    }
    if (
      options.sourcePort !== undefined &&
      (!Number.isInteger(options.sourcePort) || options.sourcePort < 0 || options.sourcePort > 65535)
    ) {
      throw new Error('wakeOnLan: "sourcePort" must be an integer between 0 and 65535');
    }
    const body = { mac };
    if (options.address !== undefined) {
      body.address = options.address;
    }
    if (options.port !== undefined) {
      body.port = options.port;
    }
    if (options.sourcePort !== undefined) {
      body.sourcePort = options.sourcePort;
    }
    return this.httpClient.post('/network/wake', body);
  }

  /**
   * @description Open a WebSocket connection and authenticate. `initial` holds
   * the resolve/reject of the connect() promise until the first successful
   * connection.
   * @param {object} initial - Settling wrapper of the connect() promise.
   * @example
   * this._openWebSocket({ resolve, reject });
   */
  _openWebSocket(initial) {
    this.reconnectTimer = null;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.on('open', () => {
      debug('websocket open, authenticating');
      this._send(AUTHENTICATE.INTEGRATION_REQUEST, { token: this.token });
    });
    ws.on('message', (data) => {
      this._handleMessage(data, initial).catch((e) => debug('error handling message', e));
    });
    ws.on('error', (error) => {
      this.logger.error(`websocket error on ${this.wsUrl}: ${describeError(error)}`);
    });
    ws.on('close', (code) => {
      debug('websocket closed', code);
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      if (!this.shouldReconnect) {
        return;
      }
      if (wasConnected) {
        this.logger.warn(`connection to Gladys lost (close code ${code})`);
      }
      if (code === INVALID_ACCESS_TOKEN_CLOSE_CODE) {
        // The token was refused. Gladys closes with 4000 for ANY token
        // validation error, including transient ones (DB busy at boot), and
        // the supervisor never recreates a live container that stopped
        // reconnecting (it only turns DEGRADED) — giving up would leave the
        // integration zombie. So the loop stays armed for life, but jumps
        // straight to the max delay: no point hammering the server with a
        // probably-revoked token. connect() still rejects when the refusal
        // happens during the initial connection (fail-fast for dev).
        this.logger.error(
          `authentication refused by Gladys (close code ${code}): the integration token was rejected` +
            ' — check GLADYS_INTEGRATION_TOKEN; the refusal can also be transient (Gladys booting)',
        );
        initial.reject(new Error(`GladysIntegration: authentication refused by Gladys (close code ${code})`));
        this._scheduleReconnect(initial, this.reconnectMaxDelay);
        return;
      }
      this._scheduleReconnect(initial);
    });
  }

  /**
   * @description Schedule the next reconnection attempt with exponential backoff.
   * @param {object} initial - Settling wrapper of the connect() promise.
   * @param {number} [delayOverride] - Forced delay in ms, bypassing the backoff
   * computation (used to jump straight to the max delay after a token refusal).
   * @example
   * this._scheduleReconnect(initial);
   */
  _scheduleReconnect(initial, delayOverride) {
    const delay =
      delayOverride === undefined
        ? computeBackoffDelay(this.reconnectAttempts, this.reconnectBaseDelay, this.reconnectMaxDelay)
        : delayOverride;
    this.reconnectAttempts += 1;
    this.logger.warn(
      `not connected to Gladys (${this.wsUrl}), retrying in ${delay} ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => this._openWebSocket(initial), delay);
  }

  /**
   * @description Handle one incoming WebSocket message.
   * @param {Buffer|string} rawData - Raw message data.
   * @param {object} initial - Settling wrapper of the connect() promise.
   * @example
   * await this._handleMessage(rawData, null);
   */
  async _handleMessage(rawData, initial) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch {
      debug('ignoring non-JSON message');
      return;
    }
    const { type, payload = {} } = message || {};
    switch (type) {
      case AUTHENTICATION.CONNECTED:
        await this._handleAuthenticated(initial);
        break;
      case EXTERNAL_INTEGRATION.DEVICE_SET_VALUE:
        await this._runCommand('setValue', payload, [payload.device, payload.device_feature, payload.value]);
        break;
      case EXTERNAL_INTEGRATION.DEVICE_POLL:
        await this._runCommand('poll', payload, [payload.device]);
        break;
      case EXTERNAL_INTEGRATION.CAMERA_GET_IMAGE:
        await this._runCommand('getImage', payload, [payload.device], (image) => ({ image }));
        break;
      case EXTERNAL_INTEGRATION.SCAN_REQUEST:
        await this._runHandler('scanRequest', []);
        break;
      case EXTERNAL_INTEGRATION.DEVICE_CREATED:
        this._upsertDevice(payload.device);
        this._forgetDeviceStates(payload.device);
        await this._runHandler('deviceCreated', [payload.device]);
        break;
      case EXTERNAL_INTEGRATION.DEVICE_UPDATED:
        this._upsertDevice(payload.device);
        this._forgetDeviceStates(payload.device);
        await this._runHandler('deviceUpdated', [payload.device]);
        break;
      case EXTERNAL_INTEGRATION.DEVICE_DELETED:
        this._removeDevice(payload.device);
        this._forgetDeviceStates(payload.device);
        await this._runHandler('deviceDeleted', [payload.device]);
        break;
      case EXTERNAL_INTEGRATION.CONFIG_UPDATED:
        this.config = payload.config;
        await this._runHandler('configUpdated', [payload.config]);
        break;
      case EXTERNAL_INTEGRATION.HARDWARE_UPDATED:
        await this._runHandler('hardwareUpdated', [payload.containers]);
        break;
      case EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL:
        await this._runCommand('oauthAuthorizeUrl', payload, [payload.key, payload.redirect_uri], (authorizeUrl) => ({
          authorize_url: authorizeUrl,
        }));
        break;
      case EXTERNAL_INTEGRATION.OAUTH_CALLBACK:
        await this._runCommand('oauthCallback', payload, [
          payload.key,
          { code: payload.code, state: payload.state, redirectUri: payload.redirect_uri },
        ]);
        break;
      case EXTERNAL_INTEGRATION.MESSAGE_SEND:
        // `contact` is the identity resolved by Gladys (contract B.15):
        // `{ id }` for a channel linked by code (messaging.receive: true), or
        // the target user's contact_schema values for a send-only channel
        // (receive: false). Cores predating the send-only support relayed a
        // bare `contact_id` instead.
        await this._runCommand('sendMessage', payload, [
          payload.contact !== undefined ? payload.contact : { id: payload.contact_id },
          payload.message,
        ]);
        break;
      case EXTERNAL_INTEGRATION.WEATHER_GET:
        await this._runCommand('weatherGet', payload, [payload.options], (weather) => ({ weather }));
        break;
      case EXTERNAL_INTEGRATION.WEATHER_GET_IMAGE:
        await this._runCommand('weatherGetImage', payload, [payload.key], (image) => ({ image }));
        break;
      case EXTERNAL_INTEGRATION.WEBHOOK_RECEIVED:
        // Fire-and-forget relay (contract B.17): no message_id, no ack — the
        // caller was already answered by Gladys, the handler result is ignored.
        await this._runHandler(`webhook:${payload.webhook_key}`, [this._webhookRequestOf(payload)]);
        break;
      case EXTERNAL_INTEGRATION.WEBHOOK_REQUEST:
        await this._runCommand(`webhook:${payload.webhook_key}`, payload, [this._webhookRequestOf(payload)], (result) =>
          this._mapWebhookResponse(result),
        );
        break;
      case EXTERNAL_INTEGRATION.WEBHOOK_UPDATED:
        await this._runHandler('webhookUpdated', [{ available: payload.available, webhooks: payload.webhooks }]);
        break;
      case EXTERNAL_INTEGRATION.CALENDAR_ACCOUNT_UPDATED:
        // Fire-and-forget (the config-updated family): the integration
        // re-reads its accounts and calendars.
        await this._runHandler('calendarAccountUpdated', [payload.user]);
        break;
      case EXTERNAL_INTEGRATION.ACTION_RUN:
        await this._runCommand(`action:${payload.key}`, payload, [payload.fields], (result) => ({ message: result }));
        break;
      case EXTERNAL_INTEGRATION.SCENE_ACTION_RUN:
        await this._runCommand(`sceneAction:${payload.key}`, payload, [payload.fields], (outputs) =>
          this._mapSceneActionOutputs(outputs),
        );
        break;
      case EXTERNAL_INTEGRATION.WIDGET_GET:
        await this._runCommand(
          `widget:${payload.key}`,
          payload,
          [{ settings: payload.settings, language: payload.language, units: payload.units }],
          (content) => this._mapWidgetContent(payload.key, content),
        );
        break;
      case EXTERNAL_INTEGRATION.WIDGET_GET_IMAGE:
        await this._runCommand('widgetGetImage', payload, [payload.image_key], (image) =>
          this._mapWidgetImage(payload.image_key, image),
        );
        break;
      case EXTERNAL_INTEGRATION.WIDGET_ACTION: {
        // `values` only travels for an action declaring `fields` (section 7):
        // an integration written before sees no change.
        const options = { settings: payload.settings };
        if (payload.values !== undefined) {
          options.values = payload.values;
        }
        await this._runCommand(
          `widgetAction:${payload.key}`,
          payload,
          [payload.action_key, payload.params, options],
          (result) => this._mapWidgetActionResult(result),
        );
        break;
      }
      case EXTERNAL_INTEGRATION.ENERGY_CONTRACT_PRICE:
        // The whole request reaches the handler, field for field (the state
        // the core sends: billing period, accumulations), never the message id.
        await this._runCommand(
          'energyPrice',
          payload,
          [
            {
              contract: payload.contract,
              billing_period: payload.billing_period,
              cumulative_before: payload.cumulative_before,
              intervals: payload.intervals,
            },
          ],
          (costs) => this._mapEnergyCosts(costs),
          { alwaysMap: true },
        );
        break;
      case EXTERNAL_INTEGRATION.ENERGY_CONTRACT_CURRENT:
        await this._runCommand(
          'energyCurrent',
          payload,
          [
            {
              contract: payload.contract,
              billing_period: payload.billing_period,
              cumulative: payload.cumulative,
              max_power_kw: payload.max_power_kw,
            },
          ],
          (current) => this._mapEnergyCurrent(current),
          { alwaysMap: true },
        );
        break;
      default:
        // Unknown types are ignored silently for forward compatibility (C.4).
        debug('ignoring unknown message type', type);
    }
  }

  /**
   * @description Handle a successful authentication: resynchronize local state,
   * then mark the client connected. A failed resynchronization closes the
   * socket so the standard reconnection path retries.
   * @param {object} initial - Settling wrapper of the connect() promise.
   * @example
   * await this._handleAuthenticated(null);
   */
  async _handleAuthenticated(initial) {
    debug('authenticated, resynchronizing');
    try {
      await this.getDevices();
      await this.getConfig();
    } catch (e) {
      this.logger.error(
        `authenticated on the websocket, but the host API resynchronization failed: ${describeError(e)}` +
          ' — reconnecting to retry',
      );
      this.ws.close(1000);
      return;
    }
    this.reconnectAttempts = 0;
    this.connected = true;
    this.logger.info(`connected to Gladys (${this.hostApiUrl})`);
    this.emit('connected');
    initial.resolve();
  }

  /**
   * @description Run a command handler and automatically ack it with a
   * command-result message: resolve → success — and when the resolved value is
   * not `undefined`, it is sent back in `data` (contract C.4, for commands
   * that expect an answer) —, throw → failure with the error message, missing
   * handler → failure "not implemented".
   * @param {string} name - Handler name.
   * @param {object} payload - Command payload (carries message_id).
   * @param {Array} args - Arguments passed to the handler.
   * @param {Function} [mapResult] - Optional mapping of the resolved value to
   * the `data` payload (e.g. wrap the oauth authorize URL in `{ authorize_url }`).
   * @param {object} [options] - Options.
   * @param {boolean} [options.alwaysMap] - Run `mapResult` on an `undefined`
   * result too, for the commands whose answer is mandatory (the mapping then
   * acks the missing answer as a failure instead of an empty success).
   * @example
   * await this._runCommand('setValue', payload, [payload.device, payload.device_feature, payload.value]);
   */
  async _runCommand(name, payload, args, mapResult, { alwaysMap = false } = {}) {
    const handler = this.handlers[name];
    const messageId = payload.message_id;
    if (!handler) {
      this._send(EXTERNAL_INTEGRATION.COMMAND_RESULT, {
        message_id: messageId,
        success: false,
        error: 'not implemented',
      });
      return;
    }
    try {
      const result = await handler(...args);
      const ack = { message_id: messageId, success: true };
      if (result !== undefined || alwaysMap) {
        ack.data = mapResult ? mapResult(result) : result;
      }
      this._send(EXTERNAL_INTEGRATION.COMMAND_RESULT, ack);
    } catch (e) {
      this._send(EXTERNAL_INTEGRATION.COMMAND_RESULT, { message_id: messageId, success: false, error: e.message });
    }
  }

  /**
   * @description Run an event handler if registered, swallowing its errors
   * (events have no ack).
   * @param {string} name - Handler name.
   * @param {Array} args - Arguments passed to the handler.
   * @example
   * await this._runHandler('scanRequest', []);
   */
  async _runHandler(name, args) {
    const handler = this.handlers[name];
    if (!handler) {
      return;
    }
    try {
      await handler(...args);
    } catch (e) {
      debug(`handler ${name} failed`, e.message);
    }
  }

  /**
   * @description Build the request object passed to a webhook handler from a
   * relayed webhook payload (contract B.17).
   * @param {object} payload - Payload of a webhook.received/webhook.request message.
   * @returns {object} `{ method, query, body, contentType }`.
   * @example
   * this._webhookRequestOf(payload);
   */
  _webhookRequestOf(payload) {
    return {
      method: payload.method,
      query: payload.query,
      body: payload.body,
      contentType: payload.content_type,
    };
  }

  /**
   * @description Map and validate the value resolved by a sync webhook handler
   * into the `command-result` data returned to the caller through Gladys Plus
   * (contract B.17): `{ status?, contentType?, body? }` → `{ status,
   * content_type, body }`. Throwing here acks the command as failed, and
   * Gladys answers its default empty `200`.
   * @param {object} result - Value resolved by the handler.
   * @returns {object} The `command-result` data.
   * @example
   * this._mapWebhookResponse({ status: 200, body: 'ok' });
   */
  _mapWebhookResponse(result) {
    if (typeof result !== 'object' || result === null) {
      throw new Error('onWebhook: a sync webhook response must be an object { status?, contentType?, body? }');
    }
    const data = {};
    if (result.status !== undefined) {
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 499) {
        throw new Error('onWebhook: "status" must be an integer between 200 and 499');
      }
      data.status = result.status;
    }
    if (result.contentType !== undefined) {
      if (typeof result.contentType !== 'string') {
        throw new Error('onWebhook: "contentType" must be a string');
      }
      data.content_type = result.contentType;
    }
    if (result.body !== undefined) {
      if (typeof result.body !== 'string') {
        throw new Error('onWebhook: "body" must be a string');
      }
      if (result.body.length > MAX_WEBHOOK_SYNC_BODY_SIZE) {
        throw new Error(`onWebhook: maximum sync response body size is ${MAX_WEBHOOK_SYNC_BODY_SIZE} bytes (64 KB)`);
      }
      data.body = result.body;
    }
    return data;
  }

  /**
   * @description Map the value resolved by a scene action handler into the
   * `command-result` data: the outputs object goes into `data.outputs`, the
   * core whitelists it against the declared `outputs`. Anything but a plain
   * object acks the command as failed — an output is a scalar under a
   * declared key, never a bare value.
   * @param {object} outputs - Value resolved by the handler (not undefined).
   * @returns {object} The `command-result` data.
   * @example
   * this._mapSceneActionOutputs({ clip_id: 'abc' });
   */
  _mapSceneActionOutputs(outputs) {
    if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
      throw new Error(
        'onSceneAction: the resolved outputs must be an object of the declared output keys (or undefined)',
      );
    }
    return { outputs };
  }

  /**
   * @description Map the content resolved by a widget handler into the
   * `command-result` data, validating it in dev mode.
   * @param {string} key - Widget key, for the logs.
   * @param {object} content - Value resolved by the handler.
   * @returns {object} The `command-result` data.
   * @example
   * this._mapWidgetContent('vacuum', { components: [] });
   */
  _mapWidgetContent(key, content) {
    if (isDebugEnabled()) {
      validateWidgetContent(content).forEach((issue) => debug(`widget "${key}" content: ${issue}`));
    }
    return { content };
  }

  /**
   * @description Map the image resolved by the widget image handler into the
   * `command-result` data, validating it in dev mode.
   * @param {string} imageKey - Image key, for the logs.
   * @param {string} image - Raw base64 resolved by the handler.
   * @returns {object} The `command-result` data.
   * @example
   * this._mapWidgetImage('poster-1', base64);
   */
  _mapWidgetImage(imageKey, image) {
    if (isDebugEnabled()) {
      validateWidgetImage(image).forEach((issue) => debug(`widget image "${imageKey}": ${issue}`));
    }
    return { image };
  }

  /**
   * @description Map the value resolved by a widget action handler into the
   * `command-result` data: a string or a multi-language object is the
   * message itself, `{ message }` carries it explicitly.
   * @param {string|object} result - Value resolved by the handler (not undefined).
   * @returns {object} The `command-result` data.
   * @example
   * this._mapWidgetActionResult({ en: 'Cleaning started' });
   */
  _mapWidgetActionResult(result) {
    if (typeof result === 'string') {
      return { message: result };
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('onWidgetAction: the resolved message must be a string, a multi-language object or { message }');
    }
    return { message: result.message !== undefined ? result.message : result };
  }

  /**
   * @description Map the costs resolved by the delegated pricing handler into
   * the `command-result` data: `data.costs`, one entry per requested interval.
   * Anything but an array of objects acks the command as failed — the core
   * would refuse the payload anyway, and the intervals would stay unpriced.
   * @param {Array} costs - Value resolved by the handler.
   * @returns {object} The `command-result` data.
   * @example
   * this._mapEnergyCosts([{ starts_at: '2026-01-12T05:00:00.000Z', cost: 0.2 }]);
   */
  _mapEnergyCosts(costs) {
    if (!Array.isArray(costs) || !costs.every(isPlainObject)) {
      throw new Error(
        'onEnergyPrice: the resolved costs must be an array of { starts_at, cost, components?, label? }, one per requested interval',
      );
    }
    return { costs };
  }

  /**
   * @description Map the value resolved by the current price handler into the
   * `command-result` data (`{ price, valid_until, next_price, label, next_label }`).
   * Anything but a plain object acks the command as failed.
   * @param {object} current - Value resolved by the handler.
   * @returns {object} The `command-result` data.
   * @example
   * this._mapEnergyCurrent({ price: 0.18, valid_until: '2026-01-12T06:00:00Z', next_price: 0.25 });
   */
  _mapEnergyCurrent(current) {
    if (!isPlainObject(current)) {
      throw new Error(
        'onEnergyCurrent: the resolved value must be an object { price, valid_until?, next_price?, label?, next_label? }',
      );
    }
    return current;
  }

  /**
   * @description Insert or replace a device in the local `devices` list,
   * matched by external_id.
   * @param {object} device - Device in the standard Gladys format.
   * @example
   * this._upsertDevice(device);
   */
  _upsertDevice(device) {
    this.devices = [...this.devices.filter((d) => d.external_id !== device.external_id), device];
  }

  /**
   * @description Remove a device from the local `devices` list, matched by
   * external_id.
   * @param {object} device - Device in the standard Gladys format.
   * @example
   * this._removeDevice(device);
   */
  _removeDevice(device) {
    this.devices = this.devices.filter((d) => d.external_id !== device.external_id);
  }

  /**
   * @description Forget the values publishChangedStates remembered for a
   * device: the ones published before its creation were dropped by Gladys
   * (unknown features), an update may have added features.
   * @param {object} device - Device in the standard Gladys format.
   * @example
   * this._forgetDeviceStates(device);
   */
  _forgetDeviceStates(device) {
    this.forgetPublishedStates(device.external_id);
    (device.features || []).forEach((feature) => this.forgetPublishedStates(feature.external_id));
  }

  /**
   * @description Send a message on the WebSocket using the standard envelope
   * `{ type, payload }`. Messages are dropped silently when the socket is not
   * open (no queue, contract C.4).
   * @param {string} type - Message type.
   * @param {object} payload - Message payload.
   * @example
   * this._send('external-integration.heartbeat', {});
   */
  _send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      debug('dropping message, websocket not open', type);
      return;
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }
}

module.exports = { GladysIntegration };
