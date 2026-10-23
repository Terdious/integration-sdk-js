/**
 * Test helpers of the SDK: `@gladysassistant/integration-sdk/testing`.
 */

import {
  ActionFields,
  CalendarAccount,
  Device,
  DeviceFeature,
  DeviceState,
  EnergyCalendarEntry,
  EnergyContract,
  EnergyCurrentRequest,
  EnergyPriceRequest,
  GladysIntegration,
  HardwareUpdatedContainer,
  House,
  IntegrationCalendar,
  IntegrationConfig,
  IntegrationContainer,
  IntegrationStatus,
  LinkedContact,
  LinkedUser,
  Logger,
  MessageContact,
  OutgoingMessage,
  SceneActionFields,
  WeatherGetOptions,
  WebhookMode,
  WebhookRequest,
  WebhooksInfo,
  WidgetActionValues,
  WidgetSettings,
  WeatherUnits,
} from './index';

/** An event stored by the fake Gladys: the published event (wire format) with its calendar. */
export interface FakeCalendarEvent {
  calendar_external_id: string;
  external_id: string;
  name: string;
  start: string;
  end?: string;
  full_day?: boolean;
  location?: string;
  description?: string;
  url?: string;
}

/** Options of createFakeGladys: the data the fake host API serves. */
export interface FakeGladysOptions {
  /** Integration selector. Default: 'test-integration' (external ids `ext:test-integration:…`). */
  selector?: string;
  /** Devices created by the user (GET /device, `gladys.devices` after connect). */
  devices?: Device[];
  /** Configuration values (GET /config, `gladys.config` after connect). */
  config?: IntegrationConfig;
  /** Houses (GET /house). */
  houses?: House[];
  /** Sub-containers (GET /container). */
  containers?: IntegrationContainer[];
  /** Linked contacts (GET /contact). */
  contacts?: LinkedContact[];
  /** Webhook state (GET /webhook). Default: `{ available: false, webhooks: [] }`. */
  webhooks?: WebhooksInfo;
  /** Raw results returned by scanNetwork, per scan type, e.g. `{ mdns: [...] }`. Default: `[]`. */
  scanResults?: Record<string, unknown[]>;
  /** User returned by linkContact (any code is accepted). */
  linkedUser?: LinkedUser;
  /** Users who enabled a calendar integration (GET /calendar/account). Default: none. */
  calendarAccounts?: CalendarAccount[];
  /** Calendars already pushed (GET /calendar), with their user-owned `sync`/`shared` flags. */
  calendars?: IntegrationCalendar[];
  /** Events already pushed, each with its `calendar_external_id`. */
  calendarEvents?: FakeCalendarEvent[];
  /**
   * Declared tariff calendars (the manifest `energy_contracts.calendars`): key →
   * entries `[{ starts_at, value }]`. A key absent here is undeclared (403).
   */
  energyCalendars?: Record<string, EnergyCalendarEntry[]>;
  /** Contracts referencing the integration templates (GET /energy/contract). */
  energyContracts?: EnergyContract[];
  /**
   * Consumption states already published after the fact (publishEnergyConsumption):
   * feature external id → states stamped like the core, the end of a 30-minute
   * interval or the start of a day (the fake Gladys runs in UTC).
   */
  energyConsumption?: Record<string, FakeEnergyConsumptionState[]>;
  /** GET /status response. */
  status?: IntegrationStatus;
  /** SDK logger. Default: silent. */
  logger?: Logger;
}

/** A consumption state stored by the fake Gladys (publishEnergyConsumption). */
export interface FakeEnergyConsumptionState {
  /** ISO instant the state is stamped with: the end of a 30-minute interval, the start of a day. */
  created_at: string;
  kwh: number;
}

/** One host API request received by the fake Gladys. */
export interface FakeGladysRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** Path relative to /api/integration/v1, e.g. '/state' — without its query string. */
  path: string;
  /** Query string parameters, when the request had some (`?user=`, `?external_id=`…). */
  query?: Record<string, string>;
  /** JSON body, as received (after the SDK mapping and the JSON serialization). */
  body?: any;
  /** 200, or the status of the error the fake answered (400 on an invalid payload). */
  status: number;
}

/** Ack of a command handler, as Gladys receives it. */
export interface FakeGladysAck {
  success: boolean;
  /** Resolved value of the handler, mapped like the SDK does (e.g. `{ image }`). */
  data?: any;
  /** Message of the error thrown by the handler ('not implemented' without handler). */
  error?: string;
}

/**
 * In-memory Gladys behind a fake integration (`gladys.fake`): the data the
 * host API serves (editable at any time), the record of what Gladys
 * received, and the simulations of Gladys' calls — `fake.<name>(...)` runs
 * the `on<Name>` handler with the same arguments and resolves with its ack
 * (commands) or once handled (events, whose handler errors reject).
 */
export interface FakeGladys {
  devices: Device[];
  config: IntegrationConfig;
  houses: House[];
  containers: IntegrationContainer[];
  contacts: LinkedContact[];
  webhooks: WebhooksInfo;
  scanResults: Record<string, unknown[]>;
  linkedUser: LinkedUser;
  /** Users who enabled a calendar integration; `publishCalendars` answers 404 for any other user. */
  calendarAccounts: CalendarAccount[];
  /**
   * The integration's calendars: the ones given as options plus the ones
   * pushed (`sync: true`, `shared: false`, a selector derived from the name),
   * minus the deleted ones. Toggle `sync`/`shared` here like a user would.
   */
  calendars: IntegrationCalendar[];
  /** The events pushed so far, upserted and pruned like the core does. */
  calendarEvents: FakeCalendarEvent[];
  /** Declared tariff calendars (key → entries), fed by `publishEnergyCalendar`. */
  energyCalendars: Record<string, EnergyCalendarEntry[]>;
  energyContracts: EnergyContract[];
  /**
   * The consumption states published after the fact, per feature external id,
   * upserted by instant like the core does (a 30-minute interval stamped at
   * its end, a day at its start — in UTC).
   */
  energyConsumption: Record<string, FakeEnergyConsumptionState[]>;
  status: IntegrationStatus;

  /** Every host API request received, in order — rejected ones included (status 400). */
  readonly requests: FakeGladysRequest[];
  /** Every WebSocket message sent by the integration (command acks, refresh nudges). */
  readonly wsMessages: { type: string; payload: any }[];

  /** Every published state, in order. */
  readonly states: DeviceState[];
  /** The last published list of discovered devices. */
  readonly discoveredDevices: Device[];
  /** Every published connection status, in order. */
  readonly connectionStatuses: { connected: boolean; message?: Record<string, string> }[];
  /** The last published connection status, null if none. */
  readonly connectionStatus: { connected: boolean; message?: Record<string, string> } | null;
  /** Every published transport entry, in order (wire format). */
  readonly transports: {
    device_external_id: string;
    transport: string;
    degraded?: boolean;
    message?: Record<string, string>;
  }[];
  /** Every published camera image. */
  readonly cameraImages: { device_external_id: string; image: string }[];
  /** Every fired scene event. */
  readonly sceneEvents: { key: string; data: Record<string, unknown> }[];
  /** Every message published from the channel (publishMessage). */
  readonly messages: { contact_id: string; text: string; created_at?: string }[];
  /** Every network scan request (wire format: `{ type, timeout_seconds?, port?, payload_base64? }`). */
  readonly scans: { type: string; timeout_seconds?: number; port?: number; payload_base64?: string }[];
  /** The key of every widget refresh nudge, in order. */
  readonly widgetRefreshes: string[];
  /** The number of weather refresh nudges. */
  readonly weatherRefreshes: number;
  /** Every published calendar batch, in order (wire format). */
  readonly publishedCalendars: { user: string; calendars: Record<string, unknown>[] }[];
  /** Every published event batch, in order (wire format). */
  readonly publishedCalendarEvents: {
    calendar_external_id: string;
    events: Record<string, unknown>[];
    window?: { from: string; to: string };
  }[];
  /** The external_id of every deleted calendar, in order. */
  readonly deletedCalendars: string[];
  /** Every published energy calendar batch, in order (wire format). */
  readonly publishedEnergyCalendars: { calendar_key: string; entries: Record<string, unknown>[] }[];
  /** Every published consumption batch, in order (wire format). */
  readonly publishedEnergyConsumption: {
    device_feature_external_id: string;
    intervals: Record<string, unknown>[];
  }[];
  /** The number of energy recalculation nudges. */
  readonly energyRecalculations: number;

  /** Last value published for a feature: its `state` (its `text` for a text state), undefined if none. */
  lastState(featureExternalId: string): number | string | undefined;
  /** Bodies of the accepted requests to one host API endpoint, in order. */
  bodies(method: 'GET' | 'POST' | 'DELETE', path: string): any[];

  /** Send any WebSocket message to the integration (low level); resolves with the ack, undefined for an event. */
  send(type: string, payload?: Record<string, unknown>): Promise<FakeGladysAck | undefined>;

  /** The user actions a feature (onSetValue). */
  setValue(device: Device, deviceFeature: DeviceFeature, value: number | string): Promise<FakeGladysAck>;
  /** The scheduler polls a device (onPoll). */
  poll(device: Device): Promise<FakeGladysAck>;
  /** Gladys needs a fresh camera image (onGetImage); the image is in `data.image`. */
  getImage(device: Device): Promise<FakeGladysAck>;
  /** The user asks for a device scan (onScanRequest). */
  scanRequest(): Promise<void>;
  /** The user creates a device (onDeviceCreated); also added to `devices`. */
  deviceCreated(device: Device): Promise<void>;
  /** The user updates a device (onDeviceUpdated); also replaced in `devices`. */
  deviceUpdated(device: Device): Promise<void>;
  /** The user deletes a device (onDeviceDeleted); also removed from `devices`. */
  deviceDeleted(device: Device): Promise<void>;
  /** The user saves the configuration form (onConfigUpdated); also becomes `config`. */
  configUpdated(config: IntegrationConfig): Promise<void>;
  /**
   * End the image download of a sub-container seeded with `status: 'pulling'`
   * (its start answers 202 like the core's first start of a `manual` entry):
   * it becomes 'running', or 'stopped' with `last_error` — a `startContainer`
   * waiting for it then resolves, or rejects with that code.
   */
  finishPull(name: string, options?: { lastError?: string }): void;
  /** The user changes the hardware grants (onHardwareUpdated). */
  hardwareUpdated(containers: HardwareUpdatedContainer[]): Promise<void>;
  /** The user clicks "Connect" on an oauth2/account_link field (onOAuthAuthorizeUrl); the URL is in `data.authorize_url`. */
  oauthAuthorizeUrl(key: string, redirectUri?: string): Promise<FakeGladysAck>;
  /** The OAuth2 provider redirects back (onOAuthCallback). */
  oauthCallback(key: string, params?: { code?: string; state?: string; redirectUri?: string }): Promise<FakeGladysAck>;
  /** Gladys delivers a message in the channel (onSendMessage). */
  sendMessage(contact: MessageContact, message: OutgoingMessage): Promise<FakeGladysAck>;
  /** Gladys asks for the weather (onWeatherGet); the weather is in `data.weather`. */
  weatherGet(options: WeatherGetOptions): Promise<FakeGladysAck>;
  /** Gladys asks for a weather provider image (onWeatherGetImage); the image is in `data.image`. */
  weatherGetImage(key: string): Promise<FakeGladysAck>;
  /** Gladys Plus relays a webhook call (onWebhook): no ack in 'fire_and_forget' mode (default), the mapped response in 'sync' mode. */
  webhook(
    key: string,
    request?: Partial<WebhookRequest>,
    options?: { mode?: WebhookMode },
  ): Promise<FakeGladysAck | undefined>;
  /** The Gladys Plus webhook availability changes (onWebhookUpdated); also becomes `webhooks`. */
  webhookUpdated(webhooks: WebhooksInfo): Promise<void>;
  /** The user clicks a manifest action button (onAction); the message is in `data.message`. */
  action(key: string, fields?: ActionFields): Promise<FakeGladysAck>;
  /** A scene reaches a scene action of the integration (onSceneAction); the outputs are in `data.outputs`. */
  sceneAction(key: string, fields?: SceneActionFields): Promise<FakeGladysAck>;
  /** A dashboard shows a widget (onWidgetGet; default language 'en', units 'metric'); the content is in `data.content`. */
  widgetGet(
    key: string,
    options?: { settings?: WidgetSettings; language?: string; units?: WeatherUnits },
  ): Promise<FakeGladysAck>;
  /** Gladys needs the bytes of a widget image (onWidgetGetImage); the image is in `data.image`. */
  widgetGetImage(imageKey: string): Promise<FakeGladysAck>;
  /**
   * The user taps a widget button (onWidgetAction); the message is in `data.message`. `values` is the typed form of a
   * button declaring `fields`, relayed as is (the core validates it in production).
   */
  widgetAction(
    key: string,
    actionKey: string,
    params?: Record<string, unknown>,
    options?: { settings?: WidgetSettings; values?: WidgetActionValues },
  ): Promise<FakeGladysAck>;
  /**
   * A user enabled or disabled a calendar integration, changed their account values or toggled a calendar
   * (onCalendarAccountUpdated). The served data is not changed: set `calendarAccounts` / `calendars` first.
   */
  calendarAccountUpdated(userSelector: string): Promise<void>;
  /** Gladys asks for the delegated pricing of a billing period (onEnergyPrice); the costs are in `data.costs`. */
  energyPrice(request: EnergyPriceRequest): Promise<FakeGladysAck>;
  /** Gladys asks for the current price of a delegated contract (onEnergyCurrent); the price is in `data`. */
  energyCurrent(request: EnergyCurrentRequest): Promise<FakeGladysAck>;
  /**
   * The supervisor stops the container: run the handleShutdown cleanup, then disconnect (without exiting). The
   * client disconnects even when the cleanup throws; the cleanup error then rejects.
   */
  shutdown(signal?: 'SIGTERM' | 'SIGINT'): Promise<void>;
}

/**
 * A real GladysIntegration bound to an in-memory Gladys: same methods, same
 * checks, same payload mapping — no HTTP server, no WebSocket. `connect()`
 * and `disconnect()` also wait for the async 'connected'/'disconnected'
 * listeners; `handleShutdown()` registers the cleanup run by
 * `fake.shutdown()` instead of listening to the process signals.
 */
export type FakeGladysIntegration = GladysIntegration & { readonly fake: FakeGladys };

/** Create a fake Gladys for the integration's unit tests. */
export declare function createFakeGladys(options?: FakeGladysOptions): FakeGladysIntegration;
