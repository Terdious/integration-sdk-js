/// <reference types="node" />

import { EventEmitter } from 'events';

/**
 * Options of the GladysIntegration constructor. Every option defaults to the
 * environment variables injected in the integration container (contract C.7).
 */
export interface GladysIntegrationOptions {
  /** Host API base URL. Default: GLADYS_HOST_API_URL env var. */
  hostApiUrl?: string;
  /** Integration JWT. Default: GLADYS_INTEGRATION_TOKEN env var. */
  token?: string;
  /** Integration selector. Default: GLADYS_INTEGRATION_SELECTOR env var. */
  selector?: string;
  /** First reconnection delay in milliseconds. Default: 1000. */
  reconnectBaseDelay?: number;
  /** Reconnection delay cap in milliseconds. Default: 60000. */
  reconnectMaxDelay?: number;
  /** Host API request timeout in milliseconds. Default: 15000. */
  requestTimeout?: number;
  /**
   * Logger used for the connection lifecycle logs (connections,
   * disconnections, reconnection attempts, authentication failures).
   * Default: `createLogger({ name: 'gladys-sdk' })`. Pass
   * `createLogger({ level: 'silent' })` to silence the SDK entirely.
   */
  logger?: Logger;
}

/** A device feature, in the standard Gladys format. */
export interface DeviceFeature {
  name?: string;
  external_id: string;
  selector?: string;
  category: string;
  type: string;
  unit?: string;
  min?: number;
  max?: number;
  /**
   * Resolution the physical device accepts for a setpoint (finite number > 0,
   * e.g. 0.5 for an AC steppable by half a degree), honored by the dashboard
   * +/- buttons. Absent or null = nothing declared, the UI keeps its
   * per-category default.
   */
  step?: number | null;
  read_only?: boolean;
  has_feedback?: boolean;
  keep_history?: boolean;
  last_value?: number;
  last_value_string?: string;
  /**
   * For an enum-like feature, the subset of values THIS device actually
   * supports (camera movements and presets, AC modes…): the taxonomy defines
   * the full generic value set, the integration narrows it per device. String
   * values are only accepted on the `text`/`select` feature type (dynamic
   * selects: installed TV apps, HDMI sources…). On re-publish of an
   * already-created device, the options are silently upserted by the
   * supervisor like the `params` (matched by feature external_id).
   */
  supported_options?: DeviceFeatureSupportedOption[];
  [key: string]: unknown;
}

/**
 * One labeled option of an enum-like feature (`supported_options`): `value` is
 * the scalar sent as the command value (integers everywhere; strings only on
 * the `text`/`select` type), `label` the human name, `sort_order` the display
 * order (defaulted to the array index).
 */
export interface DeviceFeatureSupportedOption {
  value: number | string;
  label: string;
  sort_order?: number;
}

/** A device param (free key/value attached to a device). */
export interface DeviceParam {
  name: string;
  value: string;
}

/** A device, in the standard Gladys format. */
export interface Device {
  id?: string;
  name?: string;
  selector?: string;
  external_id: string;
  features?: DeviceFeature[];
  params?: DeviceParam[];
  /**
   * Whether the Gladys scheduler polls the device (calls onPoll). Default
   * false: a device is polled only with `should_poll: true` AND a
   * `poll_frequency`.
   */
  should_poll?: boolean;
  /**
   * Interval between two polls, in MILLISECONDS — one of
   * DEVICE_POLL_FREQUENCIES (1 s, 2 s, 10 s, 15 s, 30 s or 1 min); any
   * other value is rejected by publishDiscoveredDevices with a 400.
   * Nothing slower than once a minute: for a slower pace, skip polls in
   * onPoll or run your own timer.
   */
  poll_frequency?: number;
  [key: string]: unknown;
}

/** One state of the POST /state batch (contract C.3). */
export interface DeviceState {
  device_feature_external_id: string;
  state?: number;
  text?: string;
  created_at?: string | Date;
}

/**
 * Integration configuration values, keyed by config_schema key. `section`
 * fields (presentational intro blocks) store no value and never appear here.
 */
export type IntegrationConfig = Record<string, unknown>;

/** Response of GET /status (contract C.3). */
export interface IntegrationStatus {
  gladys_version: string;
  service: {
    id: string;
    selector: string;
    status: string;
    version: string;
  };
}

/** Generic success response of the host API. */
export interface SuccessResponse {
  success: boolean;
}

/** Options of publishChangedStates. */
export interface PublishChangedStatesOptions {
  /**
   * Re-publish an unchanged value once its last publication is older than
   * this many milliseconds. Default: never.
   */
  heartbeat?: number;
}

/** Response of publishChangedStates. */
export interface PublishChangedStatesResponse extends SuccessResponse {
  /** Number of states actually published (0: nothing changed, no request sent). */
  count: number;
}

/** Response of POST /discovered_device. */
export interface PublishDiscoveredDevicesResponse extends SuccessResponse {
  count: number;
}

/**
 * Multi-language message, keyed by language code. The `en` key is the
 * fallback shown when the user language is missing.
 */
export type MultiLanguageMessage = { en: string } & Record<string, string>;

/** Protocol of a published sub-container port. */
export type ContainerPortProtocol = 'tcp' | 'udp';

/** A published port of a sub-container, with the host port assigned by Gladys. */
export interface ContainerPort {
  /** Port declared in the manifest, inside the container. */
  container_port: number;
  /** Protocol declared in the manifest, `tcp` when omitted. */
  protocol: ContainerPortProtocol;
  /** Host port assigned by Gladys, `null` while none has been allocated yet. */
  host_port: number | null;
  /** Multi-language label of the port, as declared in the manifest. */
  label: MultiLanguageMessage;
  /**
   * Stable identifier of the port declared in the manifest (`[a-z0-9_]{2,20}`,
   * unique across the whole manifest), `null` when the manifest declares none.
   * It makes the assigned host port referenceable by the `{{port:<name>}}`
   * placeholder of the manifest section texts (contract C.1).
   */
  name: string | null;
  /**
   * Whether the port serves a web UI reachable from a browser. `false` (manifest
   * `browsable: false`, e.g. a WebSocket endpoint waiting for devices) — the
   * supervision screen shows the assigned host port as a badge, without the
   * "Open" link.
   */
  browsable: boolean;
}

/** State of one requested hardware class of a sub-container (contract C.3). */
export interface ContainerHardwareDevice {
  /** Hardware class name, e.g. 'coral-usb', 'gpu'. */
  class: string;
  /** Whether the user granted the class. */
  granted: boolean;
  /** Whether the hardware is detected on the host. */
  available: boolean;
}

/**
 * Download of a sub-container image started by `startContainer` /
 * `restartContainer` when the image is not on the disk yet (first start of a
 * `start: "manual"` entry, whose image the install no longer pulls).
 */
export interface ContainerPullProgress {
  /** Bytes downloaded over bytes announced, 0-100; null until Docker announced a layer size. */
  progress: number | null;
  /** Layer summary, e.g. '5/12 layers'; null before the first progress event. */
  detail: string | null;
}

/** last_error codes of an asynchronous sub-container start (GET /container). */
export type ContainerStartError = 'UNABLE_TO_PULL_IMAGE' | 'UNABLE_TO_START_CONTAINER';

/** A sub-container declared in the manifest, as returned by GET /container. */
export interface IntegrationContainer {
  name: string;
  /**
   * Docker status: 'running' | 'stopped', or 'pulling' while its image is
   * being downloaded (first start of a `manual` entry; cores older than
   * this contract never report it).
   */
  status: string;
  /** Desired state kept by the supervisor, e.g. 'running' | 'stopped'. */
  desired: string;
  started_at: string | null;
  ports: ContainerPort[];
  devices?: ContainerHardwareDevice[];
  /** Progress of the image download while `status` is 'pulling', null otherwise (absent on older cores). */
  pull?: ContainerPullProgress | null;
  /**
   * Code of the last failed asynchronous start of the entry, cleared by the
   * next start or stop; null otherwise (absent on older cores). After
   * 'UNABLE_TO_PULL_IMAGE' the container stays 'stopped'.
   */
  last_error?: ContainerStartError | string | null;
  [key: string]: unknown;
}

/**
 * Answer of startContainer / restartContainer: `status: 'pulling'` (HTTP 202)
 * when the image has to be downloaded first — the container is not running
 * yet, poll `getContainers()` until it is 'running' (or 'stopped' with a
 * `last_error`).
 */
export interface ContainerControlResponse extends SuccessResponse {
  status?: 'pulling';
}

/** Payload entry of the hardware-updated event (contract C.4). */
export interface HardwareUpdatedContainer {
  name: string;
  devices: ContainerHardwareDevice[];
}

/** Capture types of the manifest `network_discovery` field (contract B.16). */
export type NetworkDiscoveryType = 'udp-broadcast' | 'udp-active-broadcast' | 'mdns' | 'ssdp';

/** Options of a mediated network scan. */
export interface NetworkScanOptions {
  /** Scan duration in seconds (1-30). */
  timeoutSeconds?: number;
}

/**
 * Options of an active broadcast scan ('udp-active-broadcast', contract B.16):
 * the integration forges the discovery request, the core broadcasts it and
 * relays the raw unicast replies.
 */
export interface NetworkActiveScanOptions extends NetworkScanOptions {
  /** Destination UDP port of the broadcast, among the manifest-declared ports. */
  port: number;
  /**
   * Discovery request to broadcast, as a Buffer or an already-base64-encoded
   * string (≤ 512 decoded bytes).
   */
  payload: Buffer | string;
}

/** Options of a Wake-on-LAN emission (contract C.3). */
export interface WakeOnLanOptions {
  /**
   * Destination IPv4 address. Default: 255.255.255.255 (the limited
   * broadcast — use the subnet broadcast, e.g. `192.168.1.255`, when the
   * device ignores the limited one).
   */
  address?: string;
  /** Destination UDP port. Default: 9. */
  port?: number;
  /** Source UDP port. Default: 0 (ephemeral port chosen by the OS). */
  sourcePort?: number;
}

/** Raw result of a 'udp-broadcast' mediated scan: one received datagram. */
export interface UdpBroadcastScanResult {
  source_ip: string;
  source_port: number;
  payload_base64: string;
}

/**
 * Raw result of an 'mdns' mediated scan: one browsed service instance. A
 * scan browses every `mdns` entry declared in the manifest and merges their
 * results. `host` and `port` stay null when no SRV record was seen during
 * the scan window; `txt` holds the raw TXT record entries (usually
 * `key=value` strings) — parseMdnsTxt turns them into an object.
 */
export interface MdnsScanResult {
  name: string;
  host: string | null;
  addresses: string[];
  port: number | null;
  txt: string[];
}

/**
 * Raw result of an 'ssdp' mediated scan: one M-SEARCH responder. `headers`
 * is the raw response text — parsing it is the integration's job.
 * `source_mac` is optional and best-effort: the core looks the responder IP
 * up in its own neighbour (ARP) table and omits the field whenever the
 * kernel has no resolved entry for that IP — a missing `source_mac` is
 * ordinary, not an error. When present, it saves asking the user to type a
 * MAC by hand to enable Wake-on-LAN on a device just discovered.
 */
export interface SsdpScanResult {
  source_ip: string;
  source_mac?: string;
  source_port: number;
  headers: string;
}

/**
 * Values of the `fields` mini-form of a manifest action (contract C.1),
 * validated by the core, the declared `default` of every field the user left
 * empty applied. A `source: "devices"` select carries the chosen device
 * external_id, a `source: "houses"` one the chosen house selector. `section`
 * fields (presentational intro blocks) store no value and never appear here.
 */
export type ActionFields = Record<string, unknown>;

/**
 * A message Gladys asks a communication integration to deliver in the
 * external channel (contract B.15).
 */
export interface OutgoingMessage {
  text: string;
  /** Attached image as a base64 string, or null. */
  file: string | null;
}

/**
 * Identity of the target of an outgoing message, resolved by Gladys
 * (contract B.15). Its shape follows the manifest `messaging.receive` flag:
 * `{ id }` — the linked contact id — for a bidirectional channel linked by
 * code (`receive: true`, Telegram-style), or the target user's
 * `contact_schema` values for a send-only notification channel
 * (`receive: false`, Free Mobile/CallMeBot-style — e.g.
 * `{ username, access_token }`).
 */
export type MessageContact = { id?: string } & Record<string, unknown>;

/** A Gladys user linked to an external contact (contract B.15). */
export interface LinkedUser {
  selector: string;
  first_name: string;
  language: string;
}

/** A linked contact of a communication integration, as returned by GET /contact. */
export interface LinkedContact {
  /** Id of the contact in the external channel. */
  contact_id: string;
  contact_name: string | null;
  /** ISO date of the linking. */
  linked_at: string | null;
  user: LinkedUser | null;
}

/**
 * Conditions of the pivot weather format (contract B.18). Anything else is
 * coerced to 'unknown' by the Gladys core. 'night' is deprecated for
 * providers: send the real condition plus `is_day: false` instead (a rainy
 * night stays 'rain').
 *
 * The last six are extensions for phenomena the original enum flattened into a
 * neighbour: freezing rain and freezing fog carried no warning as 'rain' and
 * 'fog', a thundery snow shower is neither 'snow' nor 'thunderstorm', and
 * 'wind' said nothing of a tornado or a cyclone. Keep sending the broader
 * condition when the provider cannot tell them apart.
 */
export type WeatherCondition =
  | 'clear'
  | 'partly-cloudy'
  | 'cloud'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'pouring'
  | 'sleet'
  | 'hail'
  | 'snow'
  | 'thunderstorm'
  | 'wind'
  | 'night'
  | 'unknown'
  | 'freezing-rain'
  | 'freezing-fog'
  | 'snow-thunderstorm'
  | 'sandstorm'
  | 'tornado'
  | 'hurricane';

/**
 * CAP-style severity of a weather alert (contract B.18) — Common Alerting
 * Protocol, never one provider's scale (Météo France vigilance: yellow →
 * moderate, orange → severe, red → extreme).
 */
export type WeatherAlertSeverity = 'minor' | 'moderate' | 'severe' | 'extreme';

/**
 * Phenomenon type of a weather alert (contract B.18), generalized from the
 * Météo France vigilance phenomena, the MeteoAlarm awareness types and the
 * NWS event catalog (vent violent → wind, pluie-inondation → rain, orages →
 * thunderstorm, inondation → flood, neige-verglas → snow, canicule → heat,
 * grand froid → cold, avalanches → avalanche, vagues-submersion → coastal).
 * Optional metadata: an invalid type is dropped by the core, the alert is
 * kept and rendered from its `event` text alone.
 */
export type WeatherAlertType =
  'wind' | 'rain' | 'flood' | 'thunderstorm' | 'snow' | 'heat' | 'cold' | 'avalanche' | 'coastal' | 'fog';

/** A date of the pivot weather format: ISO string, timestamp or Date. */
export type WeatherDate = string | number | Date;

/**
 * Unit system requested by Gladys (contract B.18): the user's preference.
 * Return values in that system — °C, m/s, hPa, mm, km for 'metric'; °F,
 * mph, in, mi for 'us'.
 */
export type WeatherUnits = 'metric' | 'us';

/** Options of a weather request (contract B.18), as received by onWeatherGet. */
export interface WeatherGetOptions {
  latitude: number;
  longitude: number;
  /** Preferred language of the user, e.g. 'en', 'fr'. */
  language: string;
  units: WeatherUnits;
}

/** One hourly forecast entry of the pivot weather format (≤ 24 kept by Gladys). */
export interface WeatherHourForecast {
  temperature: number;
  weather: WeatherCondition;
  datetime: WeatherDate;
  apparent_temperature?: number;
  /** Percentage, 0-100. */
  humidity?: number;
  pressure?: number;
  wind_speed?: number;
  /** Degrees, 0-360. */
  wind_direction?: number;
  wind_gust?: number;
  /** Percentage, 0-100. */
  cloud_cover?: number;
  /** Precipitation over the hour (mm for metric, in for us). */
  precipitation?: number;
  /** Percentage, 0-100. */
  precipitation_probability?: number;
  uv_index?: number;
  /**
   * Day/night rendering variant (strict boolean: anything else is dropped by
   * the core, never coerced). Absent → rendered as day.
   */
  is_day?: boolean;
}

/**
 * One daily forecast entry of the pivot weather format (≤ 8 kept by Gladys).
 * `days` may or may not include the current day: consumers filter by
 * calendar date — a provider never has to lead with today.
 */
export interface WeatherDayForecast {
  temperature_min: number;
  temperature_max: number;
  datetime: WeatherDate;
  weather?: WeatherCondition;
  /** Percentage, 0-100. */
  humidity?: number;
  wind_speed?: number;
  /** Degrees, 0-360. */
  wind_direction?: number;
  wind_gust?: number;
  /** Precipitation over the day (mm for metric, in for us). */
  precipitation?: number;
  /** Percentage, 0-100. */
  precipitation_probability?: number;
  uv_index?: number;
  sunrise?: WeatherDate;
  sunset?: WeatherDate;
}

/** One weather alert of the pivot weather format (≤ 10 kept by Gladys). */
export interface WeatherAlert {
  severity: WeatherAlertSeverity;
  /** Short name of the event (≤ 100 characters), e.g. 'Orages violents'. */
  event: string;
  /**
   * Phenomenon type, so the core can translate and iconify the alert. An
   * invalid type is dropped by the core; the alert is kept and rendered
   * from its `event` text alone.
   */
  type?: WeatherAlertType;
  /** Longer description (≤ 5000 characters — CAP descriptions run long). */
  description?: string;
  start?: WeatherDate;
  end?: WeatherDate;
}

/**
 * Metadata of one provider image of the pivot weather format (contract
 * B.18: vigilance map, rain radar, satellite view… — ≤ 3 kept by Gladys).
 * Metadata only: the bytes travel on demand through the onWeatherGetImage
 * handler, never in the weather payload.
 */
export interface WeatherImage {
  /** Image key, matching `^[a-z0-9][a-z0-9-]{0,31}$` — unique per payload. */
  key: string;
  /**
   * Display label of the image, keyed by language code (values ≤ 50
   * characters). Absent → the widget shows the raw key.
   */
  label?: Record<string, string>;
}

/**
 * The pivot weather format resolved by onWeatherGet (contract B.18), acked
 * back to Gladys as `data.weather`. Values must be in the requested unit
 * system (`WeatherGetOptions.units`); percentages are 0-100. The payload is
 * normalized and bounded by the Gladys core: unknown fields are dropped,
 * percentages clamped, unknown conditions coerced to 'unknown', arrays
 * capped (24 hours, 8 days, 10 alerts).
 */
export interface WeatherPayload {
  temperature: number;
  weather: WeatherCondition;
  datetime: WeatherDate;
  /** Feels-like temperature. */
  apparent_temperature?: number;
  /** Percentage, 0-100. */
  humidity?: number;
  pressure?: number;
  dew_point?: number;
  wind_speed?: number;
  /** Degrees, 0-360. */
  wind_direction?: number;
  wind_gust?: number;
  /** km for metric, mi for us. */
  visibility?: number;
  /** Percentage, 0-100. */
  cloud_cover?: number;
  uv_index?: number;
  sunrise?: WeatherDate;
  sunset?: WeatherDate;
  /**
   * Day/night rendering variant (strict boolean: anything else is dropped by
   * the core, never coerced). Absent → rendered as day. `weather` keeps the
   * meteorology, `is_day` drives the day/night icon variant — preferred over
   * the deprecated 'night' condition.
   */
  is_day?: boolean;
  hours?: WeatherHourForecast[];
  days?: WeatherDayForecast[];
  alerts?: WeatherAlert[];
  /**
   * Provider images declared as metadata (≤ 3): the bytes are fetched on
   * demand through onWeatherGetImage, never carried in the payload.
   */
  images?: WeatherImage[];
}

/**
 * Modes of a webhook declared in the manifest `webhooks` field (contract
 * B.17): 'fire_and_forget' — the third party only awaits an acknowledgment
 * (the Netatmo-style event stream); 'sync' — the caller awaits the
 * integration response (challenge/response registrations).
 */
export type WebhookMode = 'fire_and_forget' | 'sync';

/** One webhook of the integration, as returned by GET /webhook (contract B.17). */
export interface IntegrationWebhook {
  /** Webhook key, as declared in the manifest. */
  key: string;
  mode: WebhookMode;
  /** Ready-to-register public URL, relayed by Gladys Plus. */
  url: string;
}

/**
 * Gladys Plus webhook state of the integration (contract B.17), as returned
 * by getWebhooks() and received by onWebhookUpdated.
 */
export interface WebhooksInfo {
  /**
   * Whether the relay is available: the user linked Gladys Plus and pasted
   * their Open API key in the Configuration screen. When false, degrade to
   * poll only.
   */
  available: boolean;
  webhooks: IntegrationWebhook[];
}

/** A third-party request relayed to a webhook handler (contract B.17). */
export interface WebhookRequest {
  /** HTTP method used by the third party, e.g. 'POST'. */
  method: string;
  /** Query-string parameters of the relayed request. */
  query: Record<string, string>;
  /** Raw body relayed by the gateway. */
  body: string | null;
  /** Content type of the relayed body. */
  contentType: string | null;
}

/**
 * Response resolved by a sync webhook handler (contract B.17), returned to
 * the third party through Gladys Plus. Body ≤ 64 KB.
 */
export interface WebhookSyncResponse {
  /** HTTP status returned to the caller (200-499). */
  status?: number;
  contentType?: string;
  body?: string;
}

/**
 * Per-device transport status (contract C.3), stored in the reserved
 * GLADYS_TRANSPORT device param and rendered as a badge in the Gladys UI.
 */
export type DeviceTransport = 'local' | 'cloud' | 'unreachable';

/** One entry of the publishTransports batch. */
export interface DeviceTransportEntry {
  /** The device external_id. */
  external_id: string;
  transport: DeviceTransport;
  /**
   * Degraded state (contract C.3) — "it works, but not in the nominal mode"
   * (e.g. local sessions refused → cloud fallback). Orthogonal to `transport`:
   * the badge keeps its transport color with an orange dot overlay. An entry
   * WITHOUT `degraded` clears a previously published degraded state.
   */
  degraded?: boolean;
  /**
   * Reason of the degraded state, shown in the badge tooltip (`en` mandatory,
   * ≤ 200 characters per language). Only taken into account when `degraded`
   * is true.
   */
  message?: MultiLanguageMessage;
}

/**
 * A house configured in Gladys, as returned by GET /house (contract C.3).
 * Only these five fields are ever returned — never the alarm mode or code.
 */
export interface House {
  id: string;
  name: string;
  selector: string;
  /** Null when the user has not located the house. */
  latitude: number | null;
  /** Null when the user has not located the house. */
  longitude: number | null;
}

/** A date argument of the SDK: an ISO 8601 string (a `YYYY-MM-DD` date included) or a Date. */
export type DateInput = string | Date;

/**
 * One user who enabled a calendar integration (manifest `type: "calendar"`,
 * contract capabilities/calendar-type.md), as returned by getCalendarAccounts():
 * who to sync, with their `account_schema` values (secrets included).
 */
export interface CalendarAccount {
  user: LinkedUser;
  /** The user's `account_schema` values, keyed by field key; `{}` without a schema. */
  config: Record<string, unknown>;
}

/**
 * A calendar pushed by the integration, as returned by getCalendars(). `sync`
 * and `shared` are user-owned: `sync: false` means "skip this calendar" (its
 * events were emptied, further pushes are a 403), `shared` whether the
 * household — and the scenes — see it.
 */
export interface IntegrationCalendar {
  /** Selector of the owning user. */
  user: string;
  /** User-scoped external id: `ext:<selector>:<user_selector>:<id>`. */
  external_id: string;
  selector: string;
  name: string;
  description: string;
  /** `#rrggbb`. */
  color: string;
  sync: boolean;
  shared: boolean;
}

/** One calendar of the publishCalendars batch (contract capabilities/calendar-type.md). */
export interface CalendarInput {
  /**
   * User-scoped external id, `ext:<selector>:<user_selector>:<provider id>`
   * (≤ 255 characters) — `gladys.externalId(`${userSelector}:<provider id>`)`.
   */
  external_id: string;
  /** 1-100 characters; integration-owned, overwritten on every push. */
  name: string;
  /** ≤ 500 characters; `null` means absent (the stored value is kept). */
  description?: string | null;
  /**
   * `#rrggbb`, lowercased by the core; an invalid color is dropped (the
   * stored value kept, the default `#3174ad` applied on creation).
   */
  color?: string | null;
}

/** Response of POST /calendar. */
export interface PublishCalendarsResponse extends SuccessResponse {
  created: number;
  updated: number;
}

/** One event of the publishCalendarEvents batch (contract capabilities/calendar-type.md). */
export interface CalendarEventInput {
  /**
   * User-scoped external id, `ext:<selector>:<user_selector>:<provider UID>`
   * (≤ 255 characters) — a stable per-user identity independent of the
   * calendar: republished under another calendar of the user, the event is
   * moved. An expanded recurrence takes the UID plus the occurrence date.
   */
  external_id: string;
  /** 1-200 characters. */
  name: string;
  /**
   * Start of the event. On a `full_day` event, the calendar date as written
   * by the provider (`'2026-08-15'`, or the date part of an ISO datetime
   * whatever its offset).
   */
  start: DateInput;
  /**
   * End of the event, ≥ `start`; absent on a timed event → zero duration,
   * absent on a `full_day` event → the start day. On a `full_day` event, an
   * EXCLUSIVE calendar date (the iCalendar DTEND convention).
   */
  end?: DateInput | null;
  /** Interpreted by calendar date, stored at the midnights of the instance timezone. Default false. */
  full_day?: boolean;
  /** ≤ 500 characters. */
  location?: string | null;
  /** ≤ 1000 characters. */
  description?: string | null;
  /** http(s), ≤ 500 characters. */
  url?: string | null;
}

/**
 * Prune window of publishCalendarEvents: the integration's events overlapping
 * it (`start < to` and either `end > from` — exclusive end — or
 * `start >= from`) and absent from the pushed list are deleted. One window,
 * one request: a larger range is split into disjoint sub-windows.
 */
export interface CalendarWindow {
  from: DateInput;
  to: DateInput;
}

/** Response of POST /calendar/event. */
export interface PublishCalendarEventsResponse extends SuccessResponse {
  created: number;
  updated: number;
  /** Events pruned by the window (0 without a window). */
  deleted: number;
}

/**
 * One entry of the publishEnergyCalendar batch (contract
 * capabilities/energy-contracts.md, section 2): exactly one of `starts_at` or
 * `date`, exactly one of `value` or `price`.
 */
export interface EnergyCalendarEntryInput {
  /**
   * Start of the period the value covers, aligned on the calendar granularity:
   * a local midnight of the calendar timezone (daily), a 30- or 15-minute slot
   * of its local clock. From 5 years back to 7 days ahead.
   */
  starts_at?: DateInput | null;
  /** Daily calendars only: the local date (`YYYY-MM-DD`) in the calendar timezone. */
  date?: string | null;
  /** A string within the declared `values` enum (1-64 characters) — a colour, `holiday`, `critical-peak`… */
  value?: string | null;
  /** A price per kWh on a price calendar (no `values` declared); may be negative (a credit). */
  price?: number | null;
  /** ISO 4217 code, must match the declared `currency` when given. */
  currency?: string | null;
}

/** One entry of a tariff calendar, as returned by getEnergyCalendar(). */
export interface EnergyCalendarEntry {
  /** ISO date. */
  starts_at: string;
  /** The string value, or the price per kWh. */
  value: string | number;
}

/** Options of getEnergyCalendar. */
export interface EnergyCalendarReadOptions {
  /** Start of the window (inclusive). */
  from?: DateInput;
  /** End of the window (inclusive). */
  to?: DateInput;
  /** Maximum number of entries — the last ones when no window is given. */
  limit?: number;
}

/** Response of POST /energy/calendar. */
export interface PublishEnergyCalendarResponse extends SuccessResponse {
  /** Number of entries written. */
  count: number;
  /** Earliest instant whose value changed (ISO), null when none did. */
  changed_from: string | null;
}

/**
 * One interval of the publishEnergyConsumption batch (contract
 * host-api-endpoints.md): exactly one of `starts_at` or `date`, and the kWh
 * consumed over it.
 */
export interface EnergyConsumptionIntervalInput {
  /**
   * Start of the interval: a 30-minute slot of the Gladys timezone on a
   * 30-minute feature, a local midnight on a daily one. Elapsed (its end at
   * or before now), at most 5 years ago.
   */
  starts_at?: DateInput | null;
  /** Daily features only: the local date (`YYYY-MM-DD`) in the Gladys timezone. */
  date?: string | null;
  /** The kWh consumed over the interval: finite, ≥ 0 (converted into the feature unit core-side). */
  kwh: number;
}

/** Response of POST /energy/consumption. */
export interface PublishEnergyConsumptionResponse extends SuccessResponse {
  /** Number of distinct instants in the batch (the last value given for an instant wins). */
  count: number;
  /** Instant of the earliest state whose value changed (ISO), null when none did. */
  changed_from: string | null;
}

/** Pricing mode of an energy contract template: the core rule engine, or the integration (onEnergyPrice). */
export type EnergyPricingMode = 'rules' | 'delegated';

/**
 * Status of an energy contract: `orphaned` is a delegated contract whose
 * provider integration was uninstalled (nobody can price it anymore).
 */
export type EnergyContractStatus = 'active' | 'scheduled' | 'expired' | 'orphaned';

/**
 * A user's energy contract referencing a template of the integration, as
 * returned by getEnergyContracts() — never the meter nor the consumption.
 */
export interface EnergyContract {
  id: string;
  /** Key of the template of the manifest `energy_contracts.templates`. */
  template_key: string;
  /** `version` of the template at import; a newer one never changes the contract silently. */
  template_version: string | null;
  pricing_mode: EnergyPricingMode;
  /** Values of the template `inputs`, keyed by input key. */
  inputs: Record<string, unknown>;
  /** Inclusive, `YYYY-MM-DD` in the contract timezone. */
  valid_from: string;
  /** Inclusive, null = ongoing. */
  valid_to: string | null;
  /** IANA timezone of the contract. */
  timezone: string;
  /** ISO 4217 code. */
  currency: string;
  /** 1-31. */
  billing_period_start_day: number;
  status: EnergyContractStatus;
}

/** The contract fields sent with a delegated pricing request (never the meter). */
export interface EnergyContractRef {
  id: string;
  template_key: string;
  inputs: Record<string, unknown>;
  currency: string;
  timezone: string;
  billing_period_start_day: number;
}

/** Bounds of the billing period a delegated request covers (ISO dates). */
export interface EnergyBillingPeriod {
  starts_at: string;
  ends_at: string;
}

/** kWh of the priced feature accumulated per scope (since the start of the day, the month, the billing period). */
export interface EnergyCumulative {
  day: number;
  month: number;
  billing_period: number;
}

/** One half-hour consumption interval to price. */
export interface EnergyInterval {
  /** ISO date, start of the interval. */
  starts_at: string;
  kwh: number;
  /** Peak power over the interval (derived from the kWh when no power feature is historized). */
  max_power_kw: number;
}

/**
 * What Gladys sends with an energy-contract.price command (contract
 * capabilities/energy-contracts.md, section 3): the intervals of ONE billing
 * period (≤ 1,488, 31 days — a longer period comes in several requests, each
 * with the accumulations before its own first interval).
 */
export interface EnergyPriceRequest {
  contract: EnergyContractRef;
  billing_period: EnergyBillingPeriod;
  /** Accumulations before the first interval, since the period start (or the contract `valid_from` when later). */
  cumulative_before: EnergyCumulative;
  intervals: EnergyInterval[];
}

/** The cost of one requested interval, resolved by onEnergyPrice. */
export interface EnergyIntervalCost {
  /** The `starts_at` of the requested interval. */
  starts_at: DateInput;
  /** Finite, ≥ 0, in the contract currency: the energy only (the `fixed` components are the core's). */
  cost: number;
  /** Optional breakdown (`{ energy, tax }`, keys `[a-z0-9_-]{1,32}`); the whole cost goes to `energy` otherwise. */
  components?: Record<string, number>;
  /** Short name of the period the interval was priced in (≤ 64 characters). */
  label?: string;
}

/** What Gladys sends with an energy-contract.current command: the same state at the current instant. */
export interface EnergyCurrentRequest {
  contract: EnergyContractRef;
  billing_period: EnergyBillingPeriod;
  cumulative: EnergyCumulative;
  /** Peak power of the last interval. */
  max_power_kw: number;
}

/** The current price resolved by onEnergyCurrent (the core adds `unit: "kWh"`). */
export interface EnergyCurrentPrice {
  /** Current price per kWh in the contract currency, null when unknown. */
  price: number | null;
  /** When the price changes, null when unknown. */
  valid_until?: DateInput | null;
  /** The price from `valid_until` on, null when unknown. */
  next_price?: number | null;
  /** Short name of the current period (≤ 64 characters), e.g. 'Off-peak'. */
  label?: string;
  /** Short name of the next period. */
  next_label?: string;
}

/**
 * Flat details of a scene event (contract "scene triggers and actions"):
 * at most 30 keys, one primitive per key — a string of at most 1000
 * characters, a finite number, a boolean or null. Never a nested object or
 * an array: the event carries details, not a payload to interpret.
 */
export type SceneEventData = Record<string, string | number | boolean | null>;

/**
 * Resolved values of a scene action's `fields` (contract "scene triggers and
 * actions"): scene variables substituted, defaults applied, validated by the
 * core against the declaration. A `source: "devices"` field carries the
 * chosen device external_id, a `source: "houses"` field the chosen house
 * selector. `section` fields store no value and never appear here.
 */
export type SceneActionFields = Record<string, unknown>;

/**
 * Outputs a scene action returns to the scene (contract "scene triggers and
 * actions"): scalars only, under the declared `outputs` keys — the core
 * drops undeclared keys, coerces each value to its declared type and caps
 * strings at 10 000 characters. Never an image or a file: a picture takes
 * the camera path (publishCameraImage + the core's message.send-camera).
 */
export type SceneActionOutputs = Record<string, string | number | boolean | null | undefined>;

/**
 * Text field of a widget content: a plain string, or a multi-language object
 * whose `en` value is the fallback (contract C.1 language rule).
 */
export type WidgetText = string | MultiLanguageMessage;

/** Semantic colors of the widget vocabulary, mapped by the core to theme colors. */
export type WidgetColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export type WidgetTextVariant = 'heading' | 'body' | 'caption';

export type WidgetChartType = 'line' | 'area' | 'bar' | 'stepline';

/** History window of a device-bound chart (the chart box's interval enum). */
export type WidgetChartInterval =
  | 'last-hour'
  | 'last-twelve-hours'
  | 'last-day'
  | 'last-three-days'
  | 'last-week'
  | 'last-month'
  | 'last-three-months'
  | 'last-year';

export type WidgetCardListDisplay = 'grid' | 'list';

export type WidgetImageFit = 'cover' | 'contain';

export type WidgetButtonStyle = 'primary' | 'secondary' | 'danger';

/**
 * `text` component: escaped plain text. `heading` (≤ 40) and `caption`
 * (≤ 80) are single-line; `body` (≤ 300, default) honors line breaks.
 */
export interface WidgetTextComponent {
  type: 'text';
  text: WidgetText;
  variant?: WidgetTextVariant;
}

/**
 * `value` component: a tile — one short value (a finite number, or a string
 * ≤ 12 characters), a unit (≤ 6), a label (≤ 24). Or, in place of
 * `value`/`unit`, `device_feature` (a feature external_id of the
 * integration) for a live tile following the published states.
 */
export interface WidgetValueComponent {
  type: 'value';
  value?: number | WidgetText;
  unit?: WidgetText;
  device_feature?: string;
  label?: WidgetText;
  /** Feather icon name (`^[a-z0-9-]{1,40}$`). */
  icon?: string;
  color?: WidgetColor;
}

/**
 * `gauge` component: a tile-sized radial arc — `value` with a finite
 * `min < max`, or `device_feature` (range defaulting to the feature's).
 */
export interface WidgetGaugeComponent {
  type: 'gauge';
  value?: number;
  min?: number;
  max?: number;
  unit?: WidgetText;
  device_feature?: string;
  label?: WidgetText;
  color?: WidgetColor;
}

/** One row of a `status` component: label ≤ 40, value a number or a string ≤ 40. */
export interface WidgetStatusItem {
  label: WidgetText;
  value: number | WidgetText;
  icon?: string;
  color?: WidgetColor;
}

/** `status` component: 1–10 label / value rows with a colored dot. */
export interface WidgetStatusComponent {
  type: 'status';
  items: WidgetStatusItem[];
}

/** One point of an inline chart series: an ISO 8601 date and a finite number. */
export interface WidgetChartPoint {
  t: string;
  v: number;
}

/** One inline series of a `chart` component (name ≤ 24, 1–300 points). */
export interface WidgetChartSeries {
  name?: WidgetText;
  points: WidgetChartPoint[];
}

/**
 * A marker the core draws on a chart: a vertical line at `t`, or a dot on
 * the curve when `value` is given, with a short label (≤ 16) in its color.
 */
export interface WidgetChartAnnotation {
  t: string;
  value?: number;
  label?: WidgetText;
  color?: WidgetColor;
}

/**
 * `chart` component: 1–4 inline `series` (data the core has no history of:
 * a forecast, a charging plan, hourly prices), or 1–4 `device_features`
 * plus an `interval` (the history the core already keeps). Zero styling.
 */
export interface WidgetChartComponent {
  type: 'chart';
  series?: WidgetChartSeries[];
  device_features?: string[];
  /** Device-bound form only; absent or unknown → 'last-day'. */
  interval?: WidgetChartInterval;
  chart_type?: WidgetChartType;
  title?: WidgetText;
  unit?: WidgetText;
  /** ≤ 8 markers. */
  annotations?: WidgetChartAnnotation[];
  /** Dashed line at the current time, when the series span it. */
  now_marker?: boolean;
}

/** A link of a card-list item: https only, domain displayed next to the label. */
export interface WidgetLink {
  url: string;
  label?: WidgetText;
}

/**
 * One item of a `card-list` component (title ≤ 60, subtitle ≤ 60, ISO
 * `date`, an `image` key served through onWidgetGetImage, a badge ≤ 16, a
 * description ≤ 2000 shown in the core's detail panel, ≤ 3 links).
 */
export interface WidgetCardListItem {
  title: WidgetText;
  subtitle?: WidgetText;
  date?: string;
  /** Image key (`^[a-z0-9][a-z0-9-]{0,63}$`), resolved through onWidgetGetImage. */
  image?: string;
  badge?: { text: WidgetText; color?: WidgetColor };
  description?: WidgetText;
  links?: WidgetLink[];
}

/**
 * `card-list` component: a poster grid (`grid`, 1–12 items, 2:3 frames —
 * the cinema case) or rows (`list`, default, 1–8 items, square thumbnails).
 */
export interface WidgetCardListComponent {
  type: 'card-list';
  display?: WidgetCardListDisplay;
  items: WidgetCardListItem[];
}

/**
 * `image` component: an image in a fixed 16:9 frame, served through
 * onWidgetGetImage by key. When the bytes change, the key must change.
 */
export interface WidgetImageComponent {
  type: 'image';
  /** Image key (`^[a-z0-9][a-z0-9-]{0,63}$`). */
  key: string;
  alt?: WidgetText;
  fit?: WidgetImageFit;
}

/** Type of a field of the form behind a widget action button: the `config_schema` grammar, restricted. */
export type WidgetActionFieldType = 'string' | 'number' | 'boolean' | 'select';

/** One option of a `select` action field. */
export interface WidgetActionFieldOption {
  /** Non-empty string, the stored value. */
  value: string;
  /** Multi-language (`en` required), ≤ 40 characters. */
  label: MultiLanguageMessage;
}

/**
 * One field of the form a widget action button opens (contract "dashboard
 * widgets", section 7): the `config_schema` grammar (C.1), restricted to
 * `string` | `number` | `boolean` | `select` — no `section`, no
 * `multi_select`, no `secret`/`oauth2`/`account_link` (a dashboard is readable
 * by every user) and no `source` (the content is produced at runtime: list
 * the options yourself). The declaration is validated with the manifest's own
 * field validator; an invalid one drops the button.
 */
export interface WidgetActionField {
  /** `^[a-z0-9_]+$`, unique within the action. */
  key: string;
  type: WidgetActionFieldType;
  /** Multi-language (`en` required), ≤ 40 characters. */
  label: MultiLanguageMessage;
  /** Multi-language, ≤ 200 characters. */
  description?: MultiLanguageMessage;
  /** `string` and `number` fields only; multi-language, ≤ 40 characters. */
  placeholder?: MultiLanguageMessage;
  required?: boolean;
  /**
   * Pre-fills the form (the last price paid…) and is relayed as the value of
   * a field the user left empty; a `string` default is bounded like a typed
   * value (≤ 1000 characters), a `select` default is one of the options.
   */
  default?: string | number | boolean;
  /** `number` fields only. */
  min?: number;
  /** `number` fields only. */
  max?: number;
  /** `select` fields only: a non-empty list. */
  options?: WidgetActionFieldOption[];
  /** `select` fields only. */
  display?: 'dropdown' | 'radio';
}

/**
 * A widget action bound to a `button`: relayed to onWidgetAction with the
 * declared `params` (≤ 1 KB, never user input) and, when the action declares
 * `fields`, the `values` the user typed in the form opened by the tap,
 * validated by the core against that declaration. `confirm: true` makes the
 * frontend ask before sending (ignored on a button with `fields`: the form is
 * the confirmation).
 */
export interface WidgetButtonAction {
  /** `^[a-z0-9_]{2,32}$`, unique within the content. */
  key: string;
  params?: Record<string, unknown>;
  confirm?: boolean;
  /** At most 4 fields; an empty list is no form at all. */
  fields?: WidgetActionField[];
}

/**
 * Values typed in the form of a widget action declaring `fields` (contract
 * "dashboard widgets", section 7): validated by the core against the fields
 * of the action found in the content (unknown key, invalid value, string over
 * 1000 characters or missing required field → refused before any relay),
 * the declared `default` of every absent field applied. A user EVENT (a
 * delivery happened, at this price), never a write to the configuration.
 */
export type WidgetActionValues = Record<string, unknown>;

/**
 * `button` component (label ≤ 24): a pill carrying exactly one of `action`
 * (a widget action), `device_feature` + `value` (the standard device command
 * path, coming back through onSetValue) or `link` (https, new tab).
 */
export interface WidgetButtonComponent {
  type: 'button';
  label: WidgetText;
  icon?: string;
  style?: WidgetButtonStyle;
  action?: WidgetButtonAction;
  device_feature?: string;
  value?: number;
  link?: { url: string };
}

/** One component of a widget content (contract "dashboard widgets", section 4). */
export type WidgetComponent =
  | WidgetTextComponent
  | WidgetValueComponent
  | WidgetGaugeComponent
  | WidgetStatusComponent
  | WidgetChartComponent
  | WidgetCardListComponent
  | WidgetImageComponent
  | WidgetButtonComponent;

/**
 * The content an onWidgetGet handler resolves (contract "dashboard widgets",
 * sections 4 and 5), acked back to Gladys as `data.content`. The core
 * normalizes and bounds it (unknown types and fields dropped, texts
 * truncated, arrays capped) and applies the content budget: at most 8
 * components, 1 focal (`chart` | `card-list` | `image`), 6 tiles (`value` |
 * `gauge`), 2 texts (1 `body`), 1 `status`, 4 `button`s — dropped in
 * content order beyond, so put what matters first. The card renders its
 * slots in a canonical order whatever the order sent. An empty
 * `components` array is a valid empty state, not an error.
 */
export interface WidgetContent {
  /** Integer ≥ 1, default 1. */
  version?: number;
  /** Freshness of the content: 10-3600 s, default 60 — how fast the data moves. */
  ttl_seconds?: number;
  components: WidgetComponent[];
}

/**
 * Instance settings of a widget (the declared `settings` of the manifest,
 * defaults applied, validated by the core). A `source: "devices"` setting
 * carries the chosen device external_id, a `source: "houses"` setting the
 * chosen house selector.
 */
export type WidgetSettings = Record<string, unknown>;

/** What Gladys sends with a widget.get command (contract "dashboard widgets", section 10). */
export interface WidgetGetOptions {
  settings: WidgetSettings;
  /** ISO 639-1 language of the requesting user (`fr`, `en`…). */
  language: string;
  /** Unit preference of the requesting user. */
  units: WeatherUnits;
}

/**
 * Message an onWidgetAction handler resolves, shown as a toast (≤ 200
 * characters per language): a string, a multi-language object, or an
 * explicit `{ message }` wrapper.
 */
export type WidgetActionResult = string | MultiLanguageMessage | { message: string | MultiLanguageMessage };

/**
 * Error thrown for every non-2xx response of the Gladys host API, carrying the
 * standard Gladys error attributes.
 */
export declare class GladysApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string);
}

/** External ids of one physical device, built by `gladys.externalIds()`. */
export interface DeviceExternalIds {
  /** The device external_id: `ext:<selector>:<type>:<platformId>`. */
  device: string;
  /** Build a feature external_id: `ext:<selector>:<type>:<platformId>:<featureKey>`. */
  feature(featureKey: string): string;
}

/** Levels accepted by the logger (LOG_LEVEL env var or `level` option). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Options of createLogger. */
export interface LoggerOptions {
  /** Prefix added to every line, e.g. the module name. */
  name?: string;
  /** Pinned level, bypassing the LOG_LEVEL env var. */
  level?: LogLevel;
}

/**
 * Standard integration logger. debug/info write to stdout, warn/error to
 * stderr — both are captured by the Gladys supervisor (docker logs). The level
 * comes from the LOG_LEVEL env var (default: info) unless pinned.
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Derive a logger with a nested name: `parent:child`. */
  child(name: string): Logger;
}

/** Create a logger (see the Logger interface). */
export declare function createLogger(options?: LoggerOptions): Logger;

/** Shared default logger (no name, level from LOG_LEVEL). */
export declare const logger: Logger;

/** Standard Gladys device-feature categories (mirror of server/utils/constants.js). */
export declare const DEVICE_FEATURE_CATEGORIES: {
  readonly CHILD_LOCK: 'child-lock';
  readonly AIRQUALITY_SENSOR: 'airquality-sensor';
  readonly AIR_CONDITIONING: 'air-conditioning';
  readonly ANGLE_SENSOR: 'angle-sensor';
  readonly BATTERY: 'battery';
  readonly BATTERY_LOW: 'battery-low';
  readonly BATTERY_STORAGE: 'battery-storage';
  readonly BUTTON: 'button';
  readonly CAMERA: 'camera';
  readonly CHARGING_STATION: 'charging-station';
  readonly CUBE: 'cube';
  readonly CURRENCY: 'currency';
  readonly CO_SENSOR: 'co-sensor';
  readonly CO2_SENSOR: 'co2-sensor';
  readonly COUNTER_SENSOR: 'counter-sensor';
  readonly CURTAIN: 'curtain';
  readonly DATA: 'data';
  readonly DATARATE: 'datarate';
  readonly DEVICE_TEMPERATURE_SENSOR: 'device-temperature-sensor';
  readonly DISTANCE_SENSOR: 'distance-sensor';
  readonly DOORBELL: 'doorbell';
  readonly DURATION: 'duration';
  readonly ELECTRICAL_VEHICLE_BATTERY: 'electrical-vehicle-battery';
  readonly ELECTRICAL_VEHICLE_CHARGE: 'electrical-vehicle-charge';
  readonly ELECTRICAL_VEHICLE_DRIVE: 'electrical-vehicle-drive';
  readonly ELECTRICAL_VEHICLE_CONSUMPTION: 'electrical-vehicle-consumption';
  readonly ELECTRICAL_VEHICLE_STATE: 'electrical-vehicle-state';
  readonly ELECTRICAL_VEHICLE_CLIMATE: 'electrical-vehicle-climate';
  readonly ELECTRICAL_VEHICLE_COMMAND: 'electrical-vehicle-command';
  readonly ENERGY_SENSOR: 'energy-sensor';
  readonly ENERGY_PRODUCTION_SENSOR: 'energy-production-sensor';
  readonly FAN: 'fan';
  readonly GRID_CARBON_SENSOR: 'grid-carbon-sensor';
  readonly GRID_SENSOR: 'grid-sensor';
  readonly HEATER: 'heater';
  readonly HEPA_FILTER_MONITORING: 'hepa-filter-monitoring';
  readonly HOME_OUTPUT_SENSOR: 'home-output-sensor';
  readonly HUMIDITY_SENSOR: 'humidity-sensor';
  readonly LEAK_SENSOR: 'leak-sensor';
  readonly LIGHT: 'light';
  readonly LIGHT_SENSOR: 'light-sensor';
  readonly LEVEL_SENSOR: 'level-sensor';
  readonly MOTION_SENSOR: 'motion-sensor';
  readonly LOCK: 'lock';
  readonly MAINTENANCE: 'maintenance';
  readonly MUSIC: 'music';
  readonly NOISE_SENSOR: 'noise-sensor';
  readonly OPENING_SENSOR: 'opening-sensor';
  readonly ORP_SENSOR: 'orp-sensor';
  readonly PH_SENSOR: 'ph-sensor';
  readonly PM25_SENSOR: 'pm25-sensor';
  readonly PM10_SENSOR: 'pm10-sensor';
  readonly FORMALDEHYD_SENSOR: 'formaldehyd-sensor';
  readonly NO2_SENSOR: 'no2-sensor';
  readonly O3_SENSOR: 'o3-sensor';
  readonly SO2_SENSOR: 'so2-sensor';
  readonly PRECIPITATION_SENSOR: 'precipitation-sensor';
  readonly PRESENCE_SENSOR: 'presence-sensor';
  readonly PRESSURE_SENSOR: 'pressure-sensor';
  readonly RAIN_SENSOR: 'rain-sensor';
  readonly RISK: 'risk';
  readonly SHUTTER: 'shutter';
  readonly SIGNAL: 'signal';
  readonly SIREN: 'siren';
  readonly SISMIC_SENSOR: 'sismic-sensor';
  readonly SMOKE_SENSOR: 'smoke-sensor';
  readonly SOIL_MOISTURE_SENSOR: 'soil-moisture-sensor';
  readonly SURFACE: 'surface';
  readonly SWITCH: 'switch';
  readonly SPEED_SENSOR: 'speed-sensor';
  readonly TAMPER: 'tamper';
  readonly TELEINFORMATION: 'teleinformation';
  readonly TELEVISION: 'television';
  readonly TEMPERATURE_SENSOR: 'temperature-sensor';
  readonly THERMOSTAT: 'thermostat';
  readonly UNKNOWN: 'unknown';
  readonly UV_SENSOR: 'uv-sensor';
  readonly VIBRATION_SENSOR: 'vibration-sensor';
  readonly VOC_SENSOR: 'voc-sensor';
  readonly VOC_INDEX_SENSOR: 'voc-index-sensor';
  readonly VOC_MATTER_INDEX_SENSOR: 'voc-matter-index-sensor';
  readonly NO2_MATTER_INDEX_SENSOR: 'no2-matter-index-sensor';
  readonly VOLUME_SENSOR: 'volume-sensor';
  readonly VACUUM_CLEANER: 'vacuum-cleaner';
  readonly TEXT: 'text';
  readonly INPUT: 'input';
  readonly WATER_HEATER: 'water-heater';
  readonly WATER_VALVE: 'water-valve';
};

/** Standard Gladys device-feature types, grouped by category (mirror of server/utils/constants.js). */
export declare const DEVICE_FEATURE_TYPES: {
  readonly LIGHT: {
    readonly BINARY: 'binary';
    readonly BRIGHTNESS: 'brightness';
    readonly HUE: 'hue';
    readonly SATURATION: 'saturation';
    readonly COLOR: 'color';
    readonly TEMPERATURE: 'temperature';
    readonly POWER: 'power';
    readonly EFFECT_MODE: 'effect-mode';
    readonly EFFECT_SPEED: 'effect-speed';
  };
  readonly SENSOR: {
    readonly DECIMAL: 'decimal';
    readonly INTEGER: 'integer';
    readonly BINARY: 'binary';
    readonly PUSH: 'push';
    readonly UNKNOWN: 'unknown';
  };
  readonly TEMPERATURE_SENSOR: {
    readonly MIN: 'min';
    readonly MAX: 'max';
    readonly AVERAGE: 'average';
    readonly PROBE: 'probe';
  };
  readonly SWITCH: {
    readonly BINARY: 'binary';
    readonly POWER: 'power';
    readonly ENERGY: 'energy';
    readonly VOLTAGE: 'voltage';
    readonly CURRENT: 'current';
    readonly BURGLAR: 'burglar';
    readonly DIMMER: 'dimmer';
    readonly TARGET_CURRENT: 'target-current';
  };
  readonly LOCK: {
    readonly BINARY: 'binary';
    readonly INTEGER: 'integer';
    readonly STATE: 'state';
  };
  readonly CAMERA: {
    readonly IMAGE: 'image';
    readonly ENABLED: 'enabled';
    readonly MOVE: 'move';
    readonly PRESET: 'preset';
    readonly PAN_POSITION: 'pan-position';
    readonly TILT_POSITION: 'tilt-position';
    readonly ZOOM_POSITION: 'zoom-position';
  };
  readonly CHARGING_STATION: {
    readonly CONNECTOR_STATUS: 'connector-status';
    readonly CHARGING_STATE: 'charging-state';
  };
  readonly DOORBELL: {
    readonly RING: 'ring';
  };
  readonly SIREN: {
    readonly BINARY: 'binary';
    readonly LMH_VOLUME: 'lmh_volume';
    readonly MELODY: 'melody';
    readonly TEST_IN_PROGRESS: 'test-in-progress';
    readonly ALARM_MODE: 'alarm-mode';
    readonly ALARM_STATE: 'alarm-state';
  };
  readonly CHILD_LOCK: {
    readonly BINARY: 'binary';
  };
  readonly CUBE: {
    readonly MODE: 'mode';
    readonly ROTATION: 'rotation';
  };
  readonly BATTERY: {
    readonly INTEGER: 'integer';
    readonly CHARGING: 'charging';
  };
  readonly BATTERY_LOW: {
    readonly BINARY: 'binary';
  };
  readonly VIBRATION_SENSOR: {
    readonly BINARY: 'binary';
    readonly STATUS: 'status';
    readonly TILT_ANGLE: 'tilt-angle';
    readonly ACCELERATION_X: 'acceleration-x';
    readonly ACCELERATION_Y: 'acceleration-y';
    readonly ACCELERATION_Z: 'acceleration-z';
    readonly ANGLE_X: 'angle-x';
    readonly ANGLE_Y: 'angle-y';
    readonly ANGLE_Z: 'angle-z';
    readonly BED_ACTIVITY: 'bed-activity';
  };
  readonly BUTTON: {
    readonly CLICK: 'click';
    readonly PUSH: 'push';
  };
  readonly SIGNAL: {
    readonly QUALITY: 'integer';
  };
  readonly AIR_CONDITIONING: {
    readonly BINARY: 'binary';
    readonly MODE: 'mode';
    readonly TARGET_TEMPERATURE: 'target-temperature';
    readonly FAN_SPEED: 'fan-speed';
    readonly SWING_HORIZONTAL: 'swing-horizontal';
    readonly SWING_VERTICAL: 'swing-vertical';
  };
  readonly FAN: {
    readonly MODE: 'mode';
    readonly PERCENT: 'percent';
    readonly SPEED: 'speed';
    readonly AIRFLOW_DIRECTION: 'airflow-direction';
    readonly ROCK_SETTING: 'rock-setting';
    readonly WIND_SETTING: 'wind-setting';
  };
  readonly HEATER: {
    readonly PILOT_WIRE_MODE: 'pilot-wire-mode';
  };
  readonly SURFACE: {
    readonly DECIMAL: 'decimal';
  };
  readonly TAMPER: {
    readonly BINARY: 'binary';
  };
  readonly TELEVISION: {
    readonly BINARY: 'binary';
    readonly SOURCE: 'source';
    readonly GUIDE: 'guide';
    readonly MENU: 'menu';
    readonly TOOLS: 'tools';
    readonly INFO: 'info';
    readonly ENTER: 'enter';
    readonly RETURN: 'return';
    readonly EXIT: 'exit';
    readonly LEFT: 'left';
    readonly RIGHT: 'right';
    readonly UP: 'up';
    readonly DOWN: 'down';
    readonly CHANNEL_UP: 'channel-up';
    readonly CHANNEL_DOWN: 'channel-down';
    readonly CHANNEL_PREVIOUS: 'channel-previous';
    readonly CHANNEL: 'channel';
    readonly VOLUME_UP: 'volume-up';
    readonly VOLUME_DOWN: 'volume-down';
    readonly VOLUME_MUTE: 'volume-mute';
    readonly VOLUME: 'volume';
    readonly PLAY: 'play';
    readonly PAUSE: 'pause';
    readonly STOP: 'stop';
    readonly PREVIOUS: 'previous';
    readonly NEXT: 'next';
    readonly REWIND: 'rewind';
    readonly FORWARD: 'forward';
    readonly RECORD: 'record';
  };
  readonly MUSIC: {
    readonly VOLUME: 'volume';
    readonly PLAY: 'play';
    readonly PAUSE: 'pause';
    readonly PREVIOUS: 'previous';
    readonly NEXT: 'next';
    readonly PLAYBACK_STATE: 'playback_state';
    readonly PLAY_NOTIFICATION: 'play_notification';
  };
  readonly ENERGY_SENSOR: {
    readonly BINARY: 'binary';
    readonly POWER: 'power';
    readonly ENERGY: 'energy';
    readonly VOLTAGE: 'voltage';
    readonly CURRENT: 'current';
    readonly INDEX: 'index';
    readonly INDEX_TODAY: 'index-today';
    readonly INDEX_YESTERDAY: 'index-yesterday';
    readonly DAILY_CONSUMPTION: 'daily-consumption';
    readonly DAILY_CONSUMPTION_COST: 'daily-consumption-cost';
    readonly THIRTY_MINUTES_CONSUMPTION: 'thirty-minutes-consumption';
    readonly THIRTY_MINUTES_CONSUMPTION_COST: 'thirty-minutes-consumption-cost';
  };
  readonly ENERGY_PRODUCTION_SENSOR: {
    readonly POWER: 'power';
    readonly INDEX: 'index';
    readonly DAILY_PRODUCTION: 'daily-production';
    readonly DAILY_PRODUCTION_REVENUE: 'daily-production-revenue';
    readonly THIRTY_MINUTES_PRODUCTION: 'thirty-minutes-production';
    readonly THIRTY_MINUTES_PRODUCTION_REVENUE: 'thirty-minutes-production-revenue';
  };
  readonly GRID_CARBON_SENSOR: {
    readonly CARBON_INTENSITY: 'carbon-intensity';
    readonly CARBON_FREE_PERCENTAGE: 'carbon-free-percentage';
    readonly RENEWABLE_PERCENTAGE: 'renewable-percentage';
  };
  readonly GRID_SENSOR: {
    readonly INPUT_POWER: 'input-power';
    readonly OUTPUT_POWER: 'output-power';
    readonly POWER: 'power';
    readonly INPUT_INDEX: 'input-index';
    readonly OUTPUT_INDEX: 'output-index';
  };
  readonly HOME_OUTPUT_SENSOR: {
    readonly POWER: 'power';
    readonly INDEX: 'index';
    readonly OFF_GRID_POWER: 'off-grid-power';
    readonly OFF_GRID_INDEX: 'off-grid-index';
  };
  readonly BATTERY_STORAGE: {
    readonly BATTERY_LEVEL: 'battery-level';
    readonly CHARGE_POWER: 'charge-power';
    readonly DISCHARGE_POWER: 'discharge-power';
    readonly CHARGE_INDEX: 'charge-index';
    readonly DISCHARGE_INDEX: 'discharge-index';
    readonly BATTERY_ENERGY_REMAINING: 'battery-energy-remaining';
  };
  readonly TELEINFORMATION: {
    readonly BINARY: 'binary';
    readonly EAST: 'east';
    readonly EAIT: 'eait';
    readonly EASF01: 'easf01';
    readonly EASF02: 'easf02';
    readonly EASF03: 'easf03';
    readonly EASF04: 'easf04';
    readonly EASF05: 'easf05';
    readonly EASF06: 'easf06';
    readonly EASF07: 'easf07';
    readonly EASF08: 'easf08';
    readonly EASF09: 'easf09';
    readonly EASF10: 'easf10';
    readonly PREF: 'pref';
    readonly PCOUP: 'pcoup';
    readonly VTIC: 'vtic';
    readonly CCASN: 'ccasn';
    readonly CCASN_1: 'ccasn_1';
    readonly UMOY1: 'umoy1';
    readonly UMOY2: 'umoy2';
    readonly UMOY3: 'umoy3';
    readonly ERQ1: 'erq1';
    readonly ERQ2: 'erq2';
    readonly ERQ3: 'erq3';
    readonly ERQ4: 'erq4';
    readonly IRMS1: 'irms1';
    readonly IRMS2: 'irms2';
    readonly IRMS3: 'irms3';
    readonly URMS1: 'urms1';
    readonly URMS2: 'urms2';
    readonly URMS3: 'urms3';
    readonly EASD01: 'easd01';
    readonly EASD02: 'easd02';
    readonly EASD03: 'easd03';
    readonly EASD04: 'easd04';
    readonly NTARF: 'ntarf';
    readonly CCAIN: 'ccain';
    readonly CCAIN_1: 'ccain_1';
    readonly SINSTI: 'sinsti';
    readonly SMAXIN: 'smaxin';
    readonly SMAXIN_1: 'smaxin_1';
    readonly SMAXN: 'smaxn';
    readonly SMAXN1: 'smaxn1';
    readonly SMAXN2: 'smaxn2';
    readonly SMAXN3: 'smaxn3';
    readonly SINSTS: 'sinsts';
    readonly SINSTS1: 'sinsts1';
    readonly SINSTS2: 'sinsts2';
    readonly SINSTS3: 'sinsts3';
    readonly SMAXN_1: 'smaxn_1';
    readonly SMAXN1_1: 'smaxn1_1';
    readonly SMAXN2_1: 'smaxn2_1';
    readonly SMAXN3_1: 'smaxn3_1';
    readonly HHPHC: 'hhphc';
    readonly IMAX: 'imax';
    readonly IMAX1: 'imax1';
    readonly ADPS: 'adps';
    readonly IMAX2: 'imax2';
    readonly IMAX3: 'imax3';
    readonly ADIR1: 'adir1';
    readonly ADIR2: 'adir2';
    readonly ADIR3: 'adir3';
  };
  readonly SPEED_SENSOR: {
    readonly DECIMAL: 'decimal';
    readonly INTEGER: 'integer';
  };
  readonly UV_SENSOR: {
    readonly INTEGER: 'integer';
  };
  readonly CURRENCY: {
    readonly DECIMAL: 'decimal';
  };
  readonly PRECIPITATION_SENSOR: {
    readonly DECIMAL: 'decimal';
    readonly INTEGER: 'integer';
  };
  readonly VOLUME_SENSOR: {
    readonly DECIMAL: 'decimal';
    readonly INTEGER: 'integer';
  };
  readonly DURATION: {
    readonly DECIMAL: 'decimal';
    readonly INTEGER: 'integer';
  };
  readonly VOC_SENSOR: {
    readonly DECIMAL: 'decimal';
  };
  readonly VOC_INDEX_SENSOR: {
    readonly INTEGER: 'integer';
  };
  readonly SHUTTER: {
    readonly STATE: 'state';
    readonly POSITION: 'position';
  };
  readonly CURTAIN: {
    readonly STATE: 'state';
    readonly POSITION: 'position';
  };
  readonly DATA: {
    readonly SIZE: 'size';
  };
  readonly DATARATE: {
    readonly RATE: 'rate';
  };
  readonly UNKNOWN: {
    readonly UNKNOWN: 'unknown';
  };
  readonly THERMOSTAT: {
    readonly TARGET_TEMPERATURE: 'target-temperature';
    /** What the machine does (THERMOSTAT_MODE: off, heating, cooling…), a command. */
    readonly MODE: 'mode';
    readonly OPERATING_STATE: 'operating-state';
    /**
     * Which temperature to aim for (THERMOSTAT_PRESET: schedule, frost, away,
     * eco, night, comfort), a command — the preset_mode / system_mode split
     * of Home Assistant and Zigbee TRVs, composing with `mode`. No unit.
     */
    readonly PRESET: 'preset';
  };
  readonly AIRQUALITY_SENSOR: {
    readonly AQI: 'aqi';
  };
  readonly PH_SENSOR: {
    readonly DECIMAL: 'decimal';
  };
  readonly ORP_SENSOR: {
    readonly DECIMAL: 'decimal';
  };
  readonly TEXT: {
    readonly TEXT: 'text';
    readonly SELECT: 'select';
  };
  readonly RISK: {
    readonly INTEGER: 'integer';
  };
  readonly INPUT: {
    readonly BINARY: 'binary';
  };
  readonly LEVEL_SENSOR: {
    readonly LIQUID_STATE: 'liquid-state';
    readonly LIQUID_LEVEL_PERCENT: 'liquid-level-percent';
    readonly LIQUID_DEPTH: 'liquid-depth';
  };
  readonly SMOKE_SENSOR: {
    readonly CONTAMINATION_STATE: 'contamination-state';
    readonly MUTED: 'muted';
    readonly TEMPORARY_MUTE: 'temporary-mute';
  };
  readonly WATER_HEATER: {
    readonly BINARY: 'binary';
    readonly MODE: 'mode';
    readonly TARGET_TEMPERATURE: 'target-temperature';
    readonly REMAINING_HOT_WATER: 'remaining-hot-water';
    readonly HEATING: 'heating';
    readonly BOOST: 'boost';
  };
  readonly WATER_VALVE: {
    readonly CURRENT_DEVICE_STATUS: 'current-device-status';
    readonly FLOW: 'flow';
    readonly AUTO_CLOSE_WHEN_WATER_SHORTAGE: 'auto-close-when-water-shortage';
    readonly VALVE_WORK_STATE: 'valve-work-state';
    readonly REAL_TIME_IRRIGATION_DURATION: 'real-time-irrigation-duration';
    readonly REAL_TIME_IRRIGATION_VOLUME: 'real-time-irrigation-volume';
    readonly DAILY_IRRIGATION_VOLUME: 'daily-irrigation-volume';
  };
  readonly ELECTRICAL_VEHICLE_BATTERY: {
    readonly BATTERY_ENERGY_REMAINING: 'battery-energy-remaining';
    readonly BATTERY_LEVEL: 'battery-level';
    readonly BATTERY_POWER: 'battery-power';
    readonly BATTERY_RANGE_ESTIMATE: 'battery-range-estimate';
    readonly BATTERY_TEMPERATURE: 'battery-temperature';
    readonly BATTERY_VOLTAGE: 'battery-voltage';
  };
  readonly ELECTRICAL_VEHICLE_CHARGE: {
    readonly CHARGE_CURRENT: 'charge-current';
    readonly CHARGE_ENERGY_ADDED_TOTAL: 'charge-energy-added-total';
    readonly CHARGE_ENERGY_CONSUMPTION_TOTAL: 'charge-energy-consumption-total';
    readonly CHARGE_ON: 'charge-on';
    readonly CHARGE_POWER: 'charge-power';
    readonly CHARGE_VOLTAGE: 'charge-voltage';
    readonly LAST_CHARGE_ENERGY_ADDED: 'last-charge-energy-added';
    readonly LAST_CHARGE_ENERGY_CONSUMPTION: 'last-charge-energy-consumption';
    readonly PLUGGED: 'plugged';
    readonly TARGET_CHARGE_LIMIT: 'target-charge-limit';
    readonly TARGET_CURRENT: 'target-current';
  };
  readonly ELECTRICAL_VEHICLE_CLIMATE: {
    readonly CLIMATE_ON: 'climate-on';
    readonly INDOOR_TEMPERATURE: 'indoor-temperature';
    readonly TARGET_TEMPERATURE: 'target-temperature';
  };
  readonly ELECTRICAL_VEHICLE_COMMAND: {
    readonly ALARM: 'alarm';
    readonly LOCK: 'lock';
  };
  readonly ELECTRICAL_VEHICLE_DRIVE: {
    readonly DRIVE_ENERGY_CONSUMPTION_TOTAL: 'drive-energy-consumption-total';
    readonly SPEED: 'speed';
  };
  readonly ELECTRICAL_VEHICLE_CONSUMPTION: {
    readonly ENERGY_CONSUMPTION: 'energy-consumption';
    readonly ENERGY_EFFICIENCY: 'energy-efficiency';
  };
  readonly ELECTRICAL_VEHICLE_STATE: {
    readonly DOOR_OPENED: 'door-opened';
    readonly ODOMETER: 'odometer';
    readonly TIRE_PRESSURE: 'tire-pressure';
    readonly WINDOW_OPENED: 'window-opened';
  };
  readonly FILTER_MONITORING: {
    readonly FILTER_LIFE_REMAINING: 'filter-life-remaining';
  };
  readonly MAINTENANCE: {
    readonly LIFE_REMAINING: 'life-remaining';
  };
  readonly VACUUM_CLEANER: {
    readonly STATE: 'state';
    readonly RUN_MODE: 'run-mode';
    readonly CLEAN_MODE: 'clean-mode';
    readonly DOCK: 'dock';
  };
};

/** Standard Gladys device-feature units (mirror of server/utils/constants.js). */
export declare const DEVICE_FEATURE_UNITS: {
  readonly CELSIUS: 'celsius';
  readonly FAHRENHEIT: 'fahrenheit';
  readonly KELVIN: 'kelvin';
  readonly PERCENT: 'percent';
  readonly PASCAL: 'pascal';
  readonly HECTO_PASCAL: 'hPa';
  readonly KILO_PASCAL: 'kPa';
  readonly BAR: 'bar';
  readonly PSI: 'psi';
  readonly MILLIBAR: 'milli-bar';
  readonly LUX: 'lux';
  readonly PPM: 'ppm';
  readonly PPB: 'ppb';
  readonly PPT: 'ppt';
  readonly WATT: 'watt';
  readonly KILOWATT: 'kilowatt';
  readonly WATT_HOUR: 'watt-hour';
  readonly KILOWATT_HOUR: 'kilowatt-hour';
  readonly MEGAWATT_HOUR: 'megawatt-hour';
  readonly AMPERE: 'ampere';
  readonly MILLI_AMPERE: 'milliampere';
  readonly MILLI_VOLT: 'millivolt';
  readonly VOLT: 'volt';
  readonly KILOVOLT_AMPERE: 'kilovolt-ampere';
  readonly VOLT_AMPERE: 'volt-ampere';
  readonly VOLT_AMPERE_REACTIVE: 'volt-ampere-reactive';
  readonly WATT_HOUR_PER_KM: 'watt-hour-per-km';
  readonly KILOWATT_HOUR_PER_100_KM: 'kilowatt-hour-per-100-km';
  readonly WATT_HOUR_PER_MILE: 'watt-hour-per-mile';
  readonly KILOWATT_HOUR_PER_100_MILE: 'kilowatt-hour-per-100-mile';
  readonly GRAM_CO2_EQ_PER_KILOWATT_HOUR: 'gram-co2eq-per-kilowatt-hour';
  readonly KM_PER_KILOWATT_HOUR: 'km-per-kilowatt-hour';
  readonly MILE_PER_KILOWATT_HOUR: 'mile-per-kilowatt-hour';
  readonly MM: 'mm';
  readonly CM: 'cm';
  readonly M: 'm';
  readonly KM: 'km';
  readonly INCH: 'inch';
  readonly FEET: 'feet';
  readonly MILE: 'mile';
  readonly SQUARE_CENTIMETER: 'square-centimeter';
  readonly SQUARE_METER: 'square-meter';
  readonly SQUARE_KILOMETER: 'square-kilometer';
  readonly DEGREE: 'degree';
  readonly LITER: 'liter';
  readonly MILLILITER: 'milliliter';
  readonly CUBIC_METER: 'cubicmeter';
  readonly CUBIC_METER_PER_HOUR: 'cubic-meter-per-hour';
  readonly EURO: 'euro';
  readonly DOLLAR: 'dollar';
  readonly BITCOIN: 'bitcoin';
  readonly LITECOIN: 'litecoin';
  readonly DOGECOIN: 'dogecoin';
  readonly ETHEREUM: 'ethereum';
  readonly POUND_STERLING: 'pound-sterling';
  readonly METER_PER_SECOND: 'meter-per-second';
  readonly KILOMETER_PER_HOUR: 'kilometer-per-hour';
  readonly FEET_PER_SECOND: 'feet-per-second';
  readonly MILE_PER_HOUR: 'mile-per-hour';
  readonly MILLIMETER_PER_HOUR: 'millimeter-per-hour';
  readonly MILLIMETER_PER_DAY: 'millimeter-per-day';
  readonly UV_INDEX: 'uv-index';
  readonly MICROSECONDS: 'microseconds';
  readonly MILLISECONDS: 'milliseconds';
  readonly SECONDS: 'seconds';
  readonly MINUTES: 'minutes';
  readonly HOURS: 'hours';
  readonly DAYS: 'days';
  readonly WEEKS: 'weeks';
  readonly MONTHS: 'months';
  readonly YEARS: 'years';
  readonly BIT: 'bit';
  readonly KILOBIT: 'kilobit';
  readonly MEGABIT: 'megabit';
  readonly GIGABIT: 'gigabit';
  readonly BYTE: 'byte';
  readonly KILOBYTE: 'kilobyte';
  readonly MEGABYTE: 'megabyte';
  readonly GIGABYTE: 'gigabyte';
  readonly TERABYTE: 'terabyte';
  readonly BITS_PER_SECOND: 'bits-per-second';
  readonly KILOBITS_PER_SECOND: 'kilobits-per-second';
  readonly MEGABITS_PER_SECOND: 'megabits-per-second';
  readonly GIGABITS_PER_SECOND: 'gigabits-per-second';
  readonly BYTES_PER_SECOND: 'bytes-per-second';
  readonly KILOBYTES_PER_SECOND: 'kilobytes-per-second';
  readonly MEGABYTES_PER_SECOND: 'megabytes-per-second';
  readonly GIGABYTES_PER_SECOND: 'gigabytes-per-second';
  readonly AQI: 'aqi';
  readonly PH: 'ph';
  readonly MILLIGRAM_PER_CUBIC_METER: 'milligram-per-cubic-meter';
  readonly MICROGRAM_PER_CUBIC_METER: 'microgram-per-cubic-meter';
  readonly NANOGRAM_PER_CUBIC_METER: 'nanogram-per-cubic-meter';
  readonly PARTICLES_PER_CUBIC_METER: 'particles-per-cubic-meter';
  readonly BECQUEREL_PER_CUBIC_METER: 'becquerel-per-cubic-meter';
  readonly DECIBEL: 'decibel';
};

/**
 * The only values a device `poll_frequency` accepts, in MILLISECONDS (mirror
 * of server/utils/constants.js). The device must also carry `should_poll: true`.
 */
export declare const DEVICE_POLL_FREQUENCIES: {
  readonly EVERY_MINUTES: 60000;
  readonly EVERY_30_SECONDS: 30000;
  readonly EVERY_15_SECONDS: 15000;
  readonly EVERY_10_SECONDS: 10000;
  readonly EVERY_2_SECONDS: 2000;
  readonly EVERY_SECONDS: 1000;
};

/**
 * Parse the raw TXT record entries of an 'mdns' scan result
 * (`["id=AA:BB", "sf=1"]`) into an object, following RFC 6763 section 6:
 * keys lowercased (they are case-insensitive), the value is everything after
 * the first '=', an entry without '=' is a boolean attribute (`true`), only
 * the first occurrence of a key counts. Empty entries and empty keys are
 * ignored; anything but an array gives `{}`.
 */
export declare function parseMdnsTxt(txt: string[] | null | undefined): Record<string, string | true>;

/** WebSocket message types of the integration protocol (contract C.4). */
export declare const WEBSOCKET_MESSAGE_TYPES: {
  AUTHENTICATE: { INTEGRATION_REQUEST: string };
  AUTHENTICATION: { CONNECTED: string };
  EXTERNAL_INTEGRATION: {
    DEVICE_SET_VALUE: string;
    DEVICE_POLL: string;
    COMMAND_RESULT: string;
    SCAN_REQUEST: string;
    DEVICE_CREATED: string;
    DEVICE_UPDATED: string;
    DEVICE_DELETED: string;
    CONFIG_UPDATED: string;
    HARDWARE_UPDATED: string;
    OAUTH_GET_AUTHORIZE_URL: string;
    OAUTH_CALLBACK: string;
    ACTION_RUN: string;
    CAMERA_GET_IMAGE: string;
    WEATHER_GET: string;
    WEATHER_GET_IMAGE: string;
    WEATHER_REFRESH: string;
    MESSAGE_SEND: string;
    WEBHOOK_RECEIVED: string;
    WEBHOOK_REQUEST: string;
    WEBHOOK_UPDATED: string;
    CALENDAR_ACCOUNT_UPDATED: string;
    SCENE_ACTION_RUN: string;
    WIDGET_GET: string;
    WIDGET_GET_IMAGE: string;
    WIDGET_ACTION: string;
    WIDGET_REFRESH: string;
    ENERGY_CONTRACT_PRICE: string;
    ENERGY_CONTRACT_CURRENT: string;
    ENERGY_CALENDAR_REFRESH: string;
    HEARTBEAT: string;
  };
};

/** Values of the per-device transport status (contract C.3). */
export declare const DEVICE_TRANSPORTS: {
  readonly LOCAL: 'local';
  readonly CLOUD: 'cloud';
  readonly UNREACHABLE: 'unreachable';
};

/** Conditions of the pivot weather format (contract B.18). */
export declare const WEATHER_CONDITIONS: {
  readonly CLEAR: 'clear';
  readonly PARTLY_CLOUDY: 'partly-cloudy';
  readonly CLOUD: 'cloud';
  readonly FOG: 'fog';
  readonly DRIZZLE: 'drizzle';
  readonly RAIN: 'rain';
  readonly POURING: 'pouring';
  readonly SLEET: 'sleet';
  readonly HAIL: 'hail';
  readonly SNOW: 'snow';
  readonly THUNDERSTORM: 'thunderstorm';
  readonly WIND: 'wind';
  /** Deprecated for providers: send the real condition + `is_day: false`. */
  readonly NIGHT: 'night';
  readonly UNKNOWN: 'unknown';
  readonly FREEZING_RAIN: 'freezing-rain';
  readonly FREEZING_FOG: 'freezing-fog';
  readonly SNOW_THUNDERSTORM: 'snow-thunderstorm';
  readonly SANDSTORM: 'sandstorm';
  readonly TORNADO: 'tornado';
  readonly HURRICANE: 'hurricane';
};

/** CAP-style severities of the weather alerts (contract B.18). */
export declare const WEATHER_ALERT_SEVERITIES: {
  readonly MINOR: 'minor';
  readonly MODERATE: 'moderate';
  readonly SEVERE: 'severe';
  readonly EXTREME: 'extreme';
};

/** Phenomenon types of the weather alerts (contract B.18). */
export declare const WEATHER_ALERT_TYPES: {
  readonly WIND: 'wind';
  readonly RAIN: 'rain';
  readonly FLOOD: 'flood';
  readonly THUNDERSTORM: 'thunderstorm';
  readonly SNOW: 'snow';
  readonly HEAT: 'heat';
  readonly COLD: 'cold';
  readonly AVALANCHE: 'avalanche';
  readonly COASTAL: 'coastal';
  readonly FOG: 'fog';
};

/** Semantic colors of the widget content vocabulary (contract "dashboard widgets"). */
export declare const WIDGET_COLORS: {
  readonly NEUTRAL: 'neutral';
  readonly PRIMARY: 'primary';
  readonly SUCCESS: 'success';
  readonly WARNING: 'warning';
  readonly DANGER: 'danger';
  readonly INFO: 'info';
};

/** Variants of the widget `text` component. */
export declare const WIDGET_TEXT_VARIANTS: {
  readonly HEADING: 'heading';
  readonly BODY: 'body';
  readonly CAPTION: 'caption';
};

/** Rendering types of the widget `chart` component. */
export declare const WIDGET_CHART_TYPES: {
  readonly LINE: 'line';
  readonly AREA: 'area';
  readonly BAR: 'bar';
  readonly STEPLINE: 'stepline';
};

/** History windows of a device-bound widget `chart`. */
export declare const WIDGET_CHART_INTERVALS: {
  readonly LAST_HOUR: 'last-hour';
  readonly LAST_TWELVE_HOURS: 'last-twelve-hours';
  readonly LAST_DAY: 'last-day';
  readonly LAST_THREE_DAYS: 'last-three-days';
  readonly LAST_WEEK: 'last-week';
  readonly LAST_MONTH: 'last-month';
  readonly LAST_THREE_MONTHS: 'last-three-months';
  readonly LAST_YEAR: 'last-year';
};

/** Displays of the widget `card-list` component. */
export declare const WIDGET_CARD_LIST_DISPLAYS: {
  readonly GRID: 'grid';
  readonly LIST: 'list';
};

/** Fits of the widget `image` component. */
export declare const WIDGET_IMAGE_FITS: {
  readonly COVER: 'cover';
  readonly CONTAIN: 'contain';
};

/** Styles of the widget `button` component. */
export declare const WIDGET_BUTTON_STYLES: {
  readonly PRIMARY: 'primary';
  readonly SECONDARY: 'secondary';
  readonly DANGER: 'danger';
};

/**
 * Validate a widget content the way the Gladys core will normalize it
 * (contract "dashboard widgets", sections 4 and 5): returns, as
 * human-readable strings, what the core would refuse (the whole content),
 * drop (a component, an item) or silently alter (a truncated text, a
 * clamped TTL, an ignored optional field). Empty when the content reaches
 * the dashboard exactly as sent. Run by the SDK in dev mode
 * (DEBUG=gladys-integration-sdk) on every content an onWidgetGet handler
 * resolves; also handy in the integration's own tests.
 */
export declare function validateWidgetContent(content: unknown): string[];

/**
 * Validate an image the way the Gladys core will (contract "dashboard
 * widgets", section 6): raw base64 of a PNG, JPEG or WebP (magic numbers)
 * of at most 300 KB decoded, whose header declares at most 4096 × 4096
 * pixels. Returns the violations as human-readable strings, empty when the
 * core serves the image. Run by the SDK in dev mode on every image an
 * onWidgetGetImage handler resolves.
 */
export declare function validateWidgetImage(rawBase64: unknown): string[];

/**
 * Client of the Gladys host API + integration WebSocket. See the README for a
 * complete example.
 */
export declare class GladysIntegration extends EventEmitter {
  constructor(options?: GladysIntegrationOptions);

  /** Integration selector (from options or GLADYS_INTEGRATION_SELECTOR). */
  readonly selector: string;
  /** Host API base URL, without trailing slash. */
  readonly hostApiUrl: string;
  /** Logger used for the connection lifecycle logs. */
  readonly logger: Logger;
  /** Devices of the integration created by the user (refreshed on every (re)connection). */
  devices: Device[];
  /** Configuration values (refreshed on every (re)connection and on config-updated). */
  config: IntegrationConfig;
  /** True while the WebSocket is authenticated. */
  connected: boolean;

  /**
   * Open the WebSocket, authenticate, resynchronize (GET /device + GET /config),
   * then resolve. Reconnects automatically for life with exponential backoff
   * min(1s * 2^n, 60s); every reconnection re-authenticates and resynchronizes.
   * A token refused by Gladys (close code 4000) keeps the loop armed but jumps
   * straight to the max delay — the refusal may be transient. connect() rejects
   * when the refusal happens during the initial connection.
   */
  connect(): Promise<void>;

  /** Close the connection cleanly and stop reconnecting. */
  disconnect(): Promise<void>;

  /** Build a namespaced external id: `ext:<selector>:<suffix>`. */
  externalId(suffix: string): string;

  /**
   * Build the external ids of ONE physical device: its device id and a factory
   * for its feature ids. `platformId` must be the unique id the external
   * platform gives you (serial, cloud id, Zigbee IEEE address, MAC…), never a
   * hard-coded label.
   */
  externalIds(type: string, platformId: string): DeviceExternalIds;

  /**
   * Exit gracefully on SIGTERM/SIGINT (sent by the supervisor when the
   * container stops): run the optional cleanup, disconnect cleanly, then exit
   * with code 0.
   */
  handleShutdown(cleanup?: (signal: 'SIGTERM' | 'SIGINT') => void | Promise<void>): void;

  /** Publish the complete list of discovered devices (replaces the previous one). */
  publishDiscoveredDevices(devices: Device[]): Promise<PublishDiscoveredDevicesResponse>;

  /** Fetch the devices created by the user; also refreshes `devices`. */
  getDevices(): Promise<Device[]>;

  /**
   * Fetch the houses configured in Gladys with their coordinates, sorted by
   * name — for integrations that own their own geo-dependent logic (water
   * restrictions, pollen, air quality…). Requires `location: true` in the
   * manifest (403 otherwise). `latitude`/`longitude` are null when the user
   * has not located the house, and several houses may exist. Fetch at
   * startup and on reconnection: there is no update event. A weather
   * integration needs neither this method nor `location: true` — the
   * coordinates reach it in the `options` of every onWeatherGet call.
   */
  getHouses(): Promise<House[]>;

  /**
   * Publish one device feature state: a number, `{ text }` for a text state, or
   * `{ state, created_at }` for a past state.
   */
  publishState(
    featureExternalId: string,
    value: number | { text: string } | { state: number; created_at?: string | Date },
  ): Promise<SuccessResponse>;

  /** Publish a batch of states (max 100 per request). */
  publishStates(states: DeviceState[]): Promise<SuccessResponse>;

  /**
   * Publish only the states whose value changed since the last one published
   * through this method for the same feature (POST /state is rate-limited to
   * 300 states/minute, sized for changes, not snapshots). Splits batches above
   * 100 states; calls run one after the other, so Gladys receives the values
   * in call order; a value is remembered only once Gladys accepted it, so a
   * failed request is re-sent by the next call. The remembered values of a
   * device are forgotten when the user creates, updates or deletes it.
   */
  publishChangedStates(
    states: DeviceState[],
    options?: PublishChangedStatesOptions,
  ): Promise<PublishChangedStatesResponse>;

  /**
   * Forget the values remembered by publishChangedStates: one feature, one
   * device (all its `<device>:<feature>` ids), or everything when omitted.
   */
  forgetPublishedStates(externalId?: string): void;

  /**
   * Publish a new image of a camera device of the integration (a device
   * carrying a `camera`/`image` feature): the dashboard camera widget updates
   * in real time. `image` is an `image/jpg;base64,...` string, limited to
   * 150 KB and 12 images/minute per device — a dedicated channel, out of the
   * states history and rate limit.
   */
  publishCameraImage(deviceExternalId: string, image: string): Promise<SuccessResponse>;

  /**
   * Publish the per-device transport status ('local' | 'cloud' |
   * 'unreachable', max 100 per request), rendered as a badge on the devices in
   * the Gladys UI in real time — the lightweight path for live switches, no
   * need to re-publish the discovered devices. The matching user preference
   * arrives in `gladys.config.GLADYS_PREFER_LOCAL`.
   */
  publishTransports(transports: DeviceTransportEntry[]): Promise<SuccessResponse>;

  /**
   * Fire a scene trigger declared in the manifest `scene_triggers` field:
   * something HAPPENED (a plate recognized, an object detected, a doorbell
   * pressed). The core matches the flat `data` against the filters the
   * scene authors configured and starts the matching scenes, exposing the
   * declared `variables` to their actions; every other key is dropped. A
   * resolved call means "accepted and evaluated once", never "a scene ran".
   * An event is a TRIGGER, never a state (a value is a device feature, a
   * picture takes the camera path); one event per TRANSITION — the core
   * admits 300 events per minute per integration (429 beyond). Throws a
   * `GladysApiError` on 400 (payload refused), 404 (undeclared key), 429.
   */
  publishSceneEvent(key: string, data?: SceneEventData): Promise<SuccessResponse>;

  /**
   * Publish a message received in the external channel (communication
   * integrations, contract B.15): Gladys resolves the contact to the linked
   * user and routes the message to the brain, the chat history and the
   * answering machinery — replies come back through `onSendMessage`. An
   * unknown (not linked) contact is rejected with a 404 `GladysApiError`.
   * Bidirectional channels only: a send-only channel
   * (`messaging: { receive: false }`) is rejected with a 403 — a
   * notification channel never talks to the brain, guaranteed server-side.
   */
  publishMessage(contactId: string, text: string, options?: { createdAt?: string | Date }): Promise<SuccessResponse>;

  /**
   * Link an external contact to a Gladys user (bidirectional communication
   * integrations — `messaging.receive: true`; a send-only channel has no
   * incoming path to relay a code, its users enter their identity in the
   * "My account" block of the Gladys UI from the manifest `contact_schema`).
   * The code proves the consent: generated by the user from the Gladys UI
   * (single use, 15 minutes TTL) and sent to the bot in the external channel.
   * Resolves with the linked user; an invalid or expired code is rejected
   * with a 404 `GladysApiError`.
   */
  linkContact(code: string, contactId: string, contactName?: string): Promise<LinkedUser>;

  /** Fetch the contacts linked to the integration, with their linked Gladys user. */
  getContacts(): Promise<LinkedContact[]>;

  /**
   * Fetch the users who ENABLED a calendar integration (manifest
   * `type: "calendar"`), with their `account_schema` values (secrets
   * included) — who to sync. Read it on every (re)connection and on
   * `onCalendarAccountUpdated`. Any other type is a 403.
   */
  getCalendarAccounts(): Promise<CalendarAccount[]>;

  /**
   * Fetch the calendars the integration pushed, with the user-owned `sync`
   * flag telling which to skip — every enabled user's when `userSelector` is
   * omitted (the startup resync).
   */
  getCalendars(userSelector?: string): Promise<IntegrationCalendar[]>;

  /**
   * Publish (upsert by `external_id`) the calendars of ONE enabled user: the
   * integration syncs, the core stores. External ids are user-scoped
   * (`ext:<selector>:<user_selector>:<id>`). `name`, `description` and
   * `color` are integration-owned (overwritten on every push); `sync`,
   * `shared` and `selector` are user-owned (never touched): a pushed calendar
   * starts private. ≤ 50 calendars per user (400), unknown or not-enabled
   * user → 404, 30 calendar writes per minute per integration (429).
   * Validated SDK-side before any request.
   */
  publishCalendars(userSelector: string, calendars: CalendarInput[]): Promise<PublishCalendarsResponse>;

  /**
   * Destroy one of the integration's calendars and its events (a
   * provider-side deletion); another integration's or an unknown one → 404.
   */
  deleteCalendar(externalId: string): Promise<SuccessResponse>;

  /**
   * Publish (upsert by `external_id`, ≤ 500 per call) a batch of events in
   * one of the integration's calendars; with `window` (`{ from, to }`), the
   * integration's events overlapping the window and absent from the list
   * are pruned (events created by hand in Gladys never are) — a
   * provider-side deletion propagates by republishing the window. One
   * window, one request: a larger range is split into disjoint sub-windows.
   * A `full_day` event is interpreted by calendar date, `end` exclusive;
   * recurrences are expanded by the integration (≤ 10 000 events per
   * calendar). Calendar of a disabled user → 404, `sync: false` → 403.
   * Validated SDK-side before any request.
   */
  publishCalendarEvents(
    calendarExternalId: string,
    events: CalendarEventInput[],
    window?: CalendarWindow,
  ): Promise<PublishCalendarEventsResponse>;

  /**
   * Publish (upsert by `starts_at`) the entries of a tariff calendar declared
   * in the manifest `energy_contracts.calendars` — day colours, holidays,
   * critical peak days (a `value` within the declared enum) or spot prices
   * per kWh (a `price`). Each entry carries `starts_at` (aligned on the
   * calendar granularity) or, on a daily calendar, `date` (`YYYY-MM-DD`);
   * ≤ 2,000 entries per call, 5 years back to 7 days ahead. An undeclared or
   * foreign key → 403. A changed value queues a bounded cost recalculation
   * core-side. Validated SDK-side before any request.
   */
  publishEnergyCalendar(key: string, entries: EnergyCalendarEntryInput[]): Promise<PublishEnergyCalendarResponse>;

  /**
   * Read back the entries of a tariff calendar the integration declares and
   * owns (resume after a restart): oldest first over `from`/`to`, the
   * `limit` last ones without a window. A key owned by another integration
   * → 403.
   */
  getEnergyCalendar(key: string, options?: EnergyCalendarReadOptions): Promise<EnergyCalendarEntry[]>;

  /**
   * Fetch the users' energy contracts referencing a template of this
   * integration — identity, inputs, validity, timezone, currency, billing
   * period, status — never the meter nor the consumption.
   */
  getEnergyContracts(): Promise<EnergyContract[]>;

  /**
   * Publish dated consumption intervals on a 30-minute or daily consumption
   * feature of this integration — for the suppliers whose readings arrive
   * after the fact: such an integration publishes no index but an
   * `energy-sensor` / `thirty-minutes-consumption` or `daily-consumption`
   * feature it feeds itself, the core derives its cost feature and prices it.
   * Each interval carries `starts_at` (aligned on a 30-minute slot of the
   * Gladys timezone, a local midnight for a daily feature) or, on a daily
   * feature, `date` (`YYYY-MM-DD`), and `kwh`; ≤ 2,000 per call, elapsed, at
   * most 5 years old. Upserted by instant (a correction replaces, never
   * duplicates; an unchanged value writes nothing); a changed value queues a
   * bounded cost recalculation of the root meter from the earliest change.
   * Device not created → 404 (retry once it exists); a feature that is not a
   * consumption, or derived from a published index → 400. Validated SDK-side
   * before any request.
   */
  publishEnergyConsumption(
    deviceFeatureExternalId: string,
    intervals: EnergyConsumptionIntervalInput[],
  ): Promise<PublishEnergyConsumptionResponse>;

  /**
   * Fetch the Gladys Plus webhook state (contract B.17): whether the relay is
   * available, and the ready-to-register public URL of each webhook declared
   * in the manifest. The Netatmo pattern: (re)register the URLs at the third
   * party on every successful connection to the service, best effort.
   * `available: false` (no Gladys Plus) → degrade to poll only.
   */
  getWebhooks(): Promise<WebhooksInfo>;

  /** Fetch the configuration (secrets included); also refreshes `config`. */
  getConfig(): Promise<IntegrationConfig>;

  /**
   * Save configuration values (partial merge). Keys of `section` fields
   * (presentational intro blocks, no stored value) are rejected by the host
   * API. Unless the manifest declares `location: true`, a `source: "houses"`
   * field only takes its stored value back unchanged (any other value is a
   * 403): the house is the user's choice.
   */
  setConfig(partialConfig: IntegrationConfig): Promise<SuccessResponse>;

  /** Fetch the Gladys version and the integration service status. */
  getStatus(): Promise<IntegrationStatus>;

  /**
   * Publish the application-level connection status of the integration, shown
   * in the Configuration screen (e.g. "token expired, please reconnect"). A
   * cloud integration can be RUNNING and still disconnected from its
   * third-party service — without this channel it would be silently broken.
   */
  setConnectionStatus(connected: boolean, message?: MultiLanguageMessage): Promise<SuccessResponse>;

  /**
   * Fetch the sub-containers declared in the manifest: Docker status, desired
   * state, assigned host ports and granted/available hardware classes.
   */
  getContainers(): Promise<IntegrationContainer[]>;

  /**
   * Create (if needed) and start a sub-container declared in the manifest —
   * typically after generating its config files in `/data`. The optional `env`
   * carries runtime-computed values, merged over the manifest env. Resolves
   * `{ success: true, status: 'pulling' }` (HTTP 202) when the image is not
   * on the disk yet (first start of a `manual` entry): the core downloads it
   * in the background then starts the container — poll `getContainers()`
   * for the 'pulling' progress and the final 'running' / `last_error`.
   */
  startContainer(name: string, options?: { env?: Record<string, string> }): Promise<ContainerControlResponse>;

  /** Stop a sub-container; the supervisor will not restart it. */
  stopContainer(name: string): Promise<SuccessResponse>;

  /**
   * Restart a sub-container, e.g. after rewriting its config through `/data`.
   * Same `status: 'pulling'` answer as startContainer when the image has to
   * be downloaded first.
   */
  restartContainer(name: string): Promise<ContainerControlResponse>;

  /**
   * Run an on-demand mediated network scan: the core — on the host network —
   * captures what the manifest `network_discovery` field declares (bridge
   * containers never receive LAN broadcast/mDNS/SSDP) and returns the RAW
   * results. Parse them yourself, join the devices through unicast, then
   * publish them with `publishDiscoveredDevices`. Undeclared type/ports → 403.
   *
   * 'udp-active-broadcast' is the query/response variant (TP-Link Kasa style):
   * the integration forges the discovery request (`payload`), the core
   * broadcasts it on `port` and relays the raw unicast replies. Guardrails:
   * broadcast only, declared ports only, payload ≤ 512 decoded bytes, 1 scan
   * per 10 s per integration (429 otherwise).
   */
  scanNetwork(type: 'udp-broadcast', options?: NetworkScanOptions): Promise<UdpBroadcastScanResult[]>;
  scanNetwork(type: 'udp-active-broadcast', options: NetworkActiveScanOptions): Promise<UdpBroadcastScanResult[]>;
  scanNetwork(type: 'mdns', options?: NetworkScanOptions): Promise<MdnsScanResult[]>;
  scanNetwork(type: 'ssdp', options?: NetworkScanOptions): Promise<SsdpScanResult[]>;
  scanNetwork(type: string, options?: NetworkScanOptions & Partial<NetworkActiveScanOptions>): Promise<unknown[]>;

  /**
   * Send a Wake-on-LAN magic packet from the Gladys core network namespace
   * (bridge containers cannot reach the LAN in broadcast). The core builds the
   * standard fixed magic packet itself — this is not a general UDP proxy.
   * Requires `network_wake: true` in the manifest (403 otherwise); 1 wake per
   * 2 s per integration (429 beyond). A resolved call means the packet was
   * emitted, not that the device actually woke up.
   */
  wakeOnLan(mac: string, options?: WakeOnLanOptions): Promise<SuccessResponse>;

  /**
   * Handler called when the user actions a device feature (auto-acked).
   * `value` is a number for every feature except the `text` category ones,
   * whose commands are strings — the free text of a `text`/`text` feature,
   * the selected option value of a `text`/`select` dynamic select.
   */
  onSetValue(
    callback: (device: Device, deviceFeature: DeviceFeature, value: number | string) => void | Promise<void>,
  ): void;

  /**
   * Handler called when the Gladys scheduler asks to poll a device
   * (auto-acked). Only the devices published with `should_poll: true` and a
   * `poll_frequency` in MILLISECONDS among DEVICE_POLL_FREQUENCIES (1 s to
   * 1 min) are scheduled.
   */
  onPoll(callback: (device: Device) => void | Promise<void>): void;

  /**
   * Handler called when Gladys needs a FRESH image of one of the integration
   * cameras — live view of the dashboard widget, chat intent (auto-acked).
   * Capture and resolve the image as an `image/jpg;base64,...` string
   * (≤ 150 KB): it is acked back as `data.image`, awaited under 15 s (not the
   * standard 5 s) so an ffmpeg-style capture fits.
   */
  onGetImage(callback: (device: Device) => string | Promise<string>): void;

  /** Handler called when the user asks for a device scan. */
  onScanRequest(callback: () => void | Promise<void>): void;

  /** Handler called when the user creates one of the discovered devices. */
  onDeviceCreated(callback: (device: Device) => void | Promise<void>): void;

  /** Handler called when the user updates one of the integration devices. */
  onDeviceUpdated(callback: (device: Device) => void | Promise<void>): void;

  /** Handler called when the user deletes one of the integration devices. */
  onDeviceDeleted(callback: (device: Device) => void | Promise<void>): void;

  /** Handler called when the user saves the configuration form. */
  onConfigUpdated(callback: (config: IntegrationConfig) => void | Promise<void>): void;

  /**
   * Handler called when the user changes the hardware grants: the affected
   * sub-containers have been recreated — regenerate their configuration and
   * (re)start what is needed.
   */
  onHardwareUpdated(callback: (containers: HardwareUpdatedContainer[]) => void | Promise<void>): void;

  /**
   * Handler called when the user clicks "Connect" on an `oauth2` or an
   * `account_link` config field (auto-acked): build and return the provider
   * authorization URL — for `oauth2`: client_id from the config, scopes, a
   * `state` you generate and remember. The resolved string is acked as
   * `data.authorize_url`. For an `account_link` field (a provider that never
   * redirects back) `redirectUri` is `undefined` and there is no callback:
   * watch for the approval yourself, then report it through
   * `setConnectionStatus(true)`.
   */
  onOAuthAuthorizeUrl(callback: (key: string, redirectUri: string | undefined) => string | Promise<string>): void;

  /**
   * Handler called when the OAuth2 provider redirects back (auto-acked):
   * verify `state`, exchange the code for the tokens, store them through
   * `setConfig` (keys outside the config_schema), then
   * `setConnectionStatus(true)`.
   */
  onOAuthCallback(
    callback: (key: string, params: { code: string; state: string; redirectUri: string }) => void | Promise<void>,
  ): void;

  /**
   * Handler called when Gladys asks a communication integration to deliver a
   * message in the external channel (auto-acked) — a reply of the brain, or a
   * notification forwarded to a user. `contact` carries the identity resolved
   * by Gladys: `{ id }` for a channel linked by code
   * (`messaging.receive: true`), or the target user's `contact_schema` values
   * for a send-only channel (`receive: false`). Users without a configured
   * identity never reach the handler.
   */
  onSendMessage(callback: (contact: MessageContact, message: OutgoingMessage) => void | Promise<void>): void;

  /**
   * Handler called when Gladys asks a weather integration (manifest
   * `type: "weather"`, contract B.18) for the weather (auto-acked) — the
   * dashboard weather widget or the chat assistant needs it. `options.units`
   * is the requesting user's preference ('metric' or 'us'): return values in
   * that unit system. Resolve the pivot weather format: it is acked back as
   * `data.weather` — awaited under 15 s (not the standard 5 s) so a fresh
   * third-party API call fits — then normalized and bounded by the Gladys
   * core. Throwing acks the command as failed, and the Gladys provider loop
   * falls through to the next provider.
   */
  onWeatherGet(callback: (options: WeatherGetOptions) => WeatherPayload | Promise<WeatherPayload>): void;

  /**
   * Handler called when Gladys asks a weather integration for one of the
   * provider images declared in the pivot's `images` metadata (contract
   * B.18: vigilance map, rain radar… — auto-acked). Registered once for all
   * keys; resolve the RAW base64 (no `data:` URI prefix) of the requested
   * image — a PNG or JPEG of at most 500 KB decoded (magic numbers and size
   * checked by the core, which caches the validated image 10 minutes and
   * serves it from its own origin). The ack is awaited under 15 s (not the
   * standard 5 s) so a fresh fetch at the provider fits.
   */
  onWeatherGetImage(callback: (key: string) => string | Promise<string>): void;

  /**
   * Send a freshness nudge to Gladys (contract B.18, weather integrations,
   * "trigger, not data"): ask the core to re-pull the weather NOW — through
   * the normal onWeatherGet path — and re-evaluate the weather-alert scene
   * triggers, instead of waiting for the 30-minute scheduled check. Carries
   * no data, expects no answer (fire-and-forget). Rate-limited by the core
   * to 1 per minute per integration, silently dropped beyond — and dropped
   * silently too while the WebSocket is disconnected.
   */
  requestWeatherRefresh(): void;

  /**
   * Handler called when a user of a calendar integration enabled or disabled
   * it from the "My calendars" block, changed their account values or toggled
   * the `sync`/`shared` flag of a calendar (no ack). Receives the user
   * selector, after the core applied the change: re-read
   * `getCalendarAccounts()` / `getCalendars(userSelector)` and adjust the
   * sync loops. Lost while disconnected: re-read both on every connection.
   */
  onCalendarAccountUpdated(callback: (userSelector: string) => void | Promise<void>): void;

  /**
   * Handler of ONE webhook declared in the manifest `webhooks` field
   * (contract B.17): third-party events pushed from the Internet, relayed by
   * Gladys Plus. Registered per webhook `key`. In `fire_and_forget` mode the
   * resolved value is ignored and errors are swallowed — use the event to
   * TRIGGER a refresh through the manufacturer API, never apply the payload
   * as a state (events arrive duplicated, late or out of order). In `sync`
   * mode, resolve with `{ status?, contentType?, body? }` (status 200-499,
   * body ≤ 64 KB) and it is returned to the third party; resolving
   * `undefined` or throwing lets Gladys answer its default empty `200`.
   */
  onWebhook(
    key: string,
    callback: (request: WebhookRequest) => WebhookSyncResponse | void | Promise<WebhookSyncResponse | void>,
  ): void;

  /**
   * Handler called when the Gladys Plus webhook availability changes (Plus
   * linked/unlinked, Open API key created or changed): re-register the fresh
   * URLs at the third party, or degrade to poll only.
   */
  onWebhookUpdated(callback: (info: WebhooksInfo) => void | Promise<void>): void;

  /**
   * Handler of ONE action declared in the manifest `actions` field, run when
   * the user clicks its button in the Configuration screen (auto-acked).
   * Registered per action `key`; receives the values of the action `fields`
   * mini-form, validated by the core, the declared `default` of every field
   * left empty applied. The resolved value (string or multi-language object) is acked
   * back as `data.message` and shown under the button. The ack is awaited
   * under the action's declared `timeout_seconds` (not the standard 5 s).
   */
  onAction(
    key: string,
    callback: (
      fields: ActionFields,
    ) => string | MultiLanguageMessage | void | Promise<string | MultiLanguageMessage | void>,
  ): void;

  /**
   * Handler of ONE scene action declared in the manifest `scene_actions`
   * field, run when a scene reaches it (auto-acked). Registered per action
   * `key`; receives the RESOLVED fields (variables substituted, defaults
   * applied, validated by the core). Resolve an object of the declared
   * `outputs` (scalars only) — acked back as `data.outputs` for the following
   * actions of the scene — or `undefined` for none. Throwing fails that
   * action only: the scene logs it and continues. The ack is awaited under
   * the action's declared `timeout_seconds` (default 30 s), a deadline that
   * starts when the scene reaches the action.
   */
  onSceneAction(
    key: string,
    callback: (fields: SceneActionFields) => SceneActionOutputs | void | Promise<SceneActionOutputs | void>,
  ): void;

  /**
   * Handler of ONE dashboard widget declared in the manifest `widgets` field
   * (auto-acked): Gladys pulls the content when a dashboard shows the widget
   * (coalesced and cached core-side per settings, language and units).
   * Registered per widget `key`; receives `{ settings, language, units }` —
   * localize the texts and the values from them. Resolve the content in the
   * core vocabulary: acked back as `data.content`, awaited under 15 s, then
   * normalized, bounded and trimmed to the content budget by the core. In
   * dev mode (DEBUG=gladys-integration-sdk) the SDK logs what the core would
   * drop or truncate — see validateWidgetContent.
   */
  onWidgetGet(key: string, callback: (options: WidgetGetOptions) => WidgetContent | Promise<WidgetContent>): void;

  /**
   * Handler called when Gladys needs the bytes of an image declared in a
   * widget content (auto-acked). Registered once for all keys (image keys are
   * integration-scoped); resolve the RAW base64 (no `data:` URI prefix) of a
   * PNG, JPEG or WebP of at most 300 KB decoded and at most 4096 × 4096
   * pixels — the core validates and REFUSES, it never recompresses: resize
   * integration-side. The core caches a validated image ONE HOUR by key: when
   * the bytes change, the key must change. Awaited under 15 s. In dev mode
   * the SDK logs why the core would refuse the image — see
   * validateWidgetImage.
   */
  onWidgetGetImage(callback: (imageKey: string) => string | Promise<string>): void;

  /**
   * Handler of the `button` actions of ONE dashboard widget (auto-acked):
   * the user tapped a button declared with an `action` in the content.
   * Registered per widget `key`; receives the tapped `actionKey`, the
   * `params` declared in the last normalized content (never user input) and
   * `{ settings, values }` — `values` the form of a button declaring
   * `fields`, validated by the core and defaults applied, ABSENT for an
   * action without `fields`. Resolve an optional toast message (string,
   * multi-language object or `{ message }`, ≤ 200 characters per language)
   * or `undefined`. After a successful action the core drops the cached
   * content and every open instance refetches. Awaited under the widget's
   * declared `action_timeout_seconds` (default 30 s).
   */
  onWidgetAction(
    key: string,
    callback: (
      actionKey: string,
      params: Record<string, unknown>,
      options: { settings: WidgetSettings; values?: WidgetActionValues },
    ) => WidgetActionResult | void | Promise<WidgetActionResult | void>,
  ): void;

  /**
   * Send a freshness nudge for ONE dashboard widget ("trigger, not data"):
   * the core drops its cached content and every open instance re-pulls it
   * through onWidgetGet, instead of waiting for the content `ttl_seconds`.
   * Carries no data, expects no answer (fire-and-forget). Rate-limited by
   * the core to 1 per 10 s per (integration, widget key), silently dropped
   * beyond — and dropped silently too while the WebSocket is disconnected.
   * Live device-bound tiles and charts need no nudge. Throws synchronously
   * when `key` is not a declarable widget key (`^[a-z0-9_]{2,32}$`).
   */
  requestWidgetRefresh(key: string): void;

  /**
   * Handler of the delegated pricing of the energy contracts capability
   * (a manifest template with `pricing_mode: "delegated"`, auto-acked): the
   * core sends the half-hour consumption intervals of ONE billing period
   * (≤ 1,488) with the contract, the period bounds and the accumulations
   * before the first interval; resolve ONE cost per requested interval, in
   * the contract currency (the energy only — the `fixed` components are the
   * core's), acked back as `data.costs` and awaited under 30 s. A retry
   * carries the same state as a first request, so the answer must be
   * deterministic. An invalid payload or a throw fails like a timeout: the
   * intervals get no new cost and the job retries.
   */
  onEnergyPrice(callback: (request: EnergyPriceRequest) => EnergyIntervalCost[] | Promise<EnergyIntervalCost[]>): void;

  /**
   * Handler of the current price of a delegated energy contract
   * (auto-acked): the same state at the current instant; resolve
   * `{ price, valid_until?, next_price?, label?, next_label? }` — acked back
   * as `data`, awaited under 5 s — for the dashboard price widget and the
   * "current price" scene condition.
   */
  onEnergyCurrent(callback: (request: EnergyCurrentRequest) => EnergyCurrentPrice | Promise<EnergyCurrentPrice>): void;

  /**
   * Send an energy calendar freshness nudge ("trigger, not data"): the core
   * recomputes the recent costs (48 hours) of the meters whose contract reads
   * a calendar the integration declares. Carries no data, expects no answer;
   * rate-limited core-side to 1 per minute per integration, ignored from an
   * integration declaring no calendar, dropped silently while disconnected.
   * `publishEnergyCalendar` already queues a recalculation from the earliest
   * changed entry: this is for the cases it does not cover.
   */
  requestEnergyRecalculation(): void;

  on(event: 'connected' | 'disconnected', listener: () => void): this;
  once(event: 'connected' | 'disconnected', listener: () => void): this;
}
