/**
 * Test helpers of the SDK, for the integrations' own unit tests:
 * `@gladysassistant/integration-sdk/testing`.
 *
 * createFakeGladys() returns a REAL GladysIntegration whose transport is an
 * in-memory Gladys: no HTTP server, no WebSocket. Every SDK method keeps its
 * real code (argument checks, payload mapping, local state, deduplication),
 * so the code under test calls exactly the API it calls in production — and
 * the fake records what Gladys RECEIVES (the JSON bodies, after the SDK
 * mapping), answers like the host API, and plays Gladys' side of the
 * WebSocket (commands, events) through `gladys.fake`.
 */

const { WEBSOCKET_MESSAGE_TYPES, MAX_CALENDARS_PER_USER } = require('./constants');
const {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
} = require('./device-constants');
const { GladysApiError } = require('./errors');
const { GladysIntegration } = require('./gladys-integration');
const { createLogger } = require('./logger');

const { EXTERNAL_INTEGRATION } = WEBSOCKET_MESSAGE_TYPES;

const POLL_FREQUENCIES = Object.values(DEVICE_POLL_FREQUENCIES);
const CATEGORIES = Object.values(DEVICE_FEATURE_CATEGORIES);
const TYPES = Object.values(DEVICE_FEATURE_TYPES).flatMap((types) => Object.values(types));
const UNITS = Object.values(DEVICE_FEATURE_UNITS);

// The consumption features an integration feeds itself (POST /energy/consumption)
// and the cumulative indexes the core derives a consumption from, as the core
// (energy-monitoring/utils) reads them.
const CONSUMPTION_FEATURE_TYPES = [
  DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
  DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
];
const ENERGY_INDEX_FEATURE_TYPES = {
  [DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR]: [
    DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
    DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
  ],
  [DEVICE_FEATURE_CATEGORIES.SWITCH]: [DEVICE_FEATURE_TYPES.SWITCH.ENERGY],
  [DEVICE_FEATURE_CATEGORIES.TELEINFORMATION]: [
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EAST,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF01,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF02,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF03,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF04,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF05,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF06,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF07,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF08,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF09,
    DEVICE_FEATURE_TYPES.TELEINFORMATION.EASF10,
  ],
};
const isEnergyIndexFeature = (feature) => (ENERGY_INDEX_FEATURE_TYPES[feature.category] || []).includes(feature.type);
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENERGY_CONSUMPTION_PAST_WINDOW_MS = 5 * 365 * DAY_MS;

/**
 * @description Clone a value through JSON, like the wire does (Dates become
 * ISO strings, undefined keys disappear).
 * @param {any} value - Value to clone.
 * @returns {any} The clone, or undefined.
 * @example
 * toWire({ created_at: new Date() });
 */
const toWire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * @description Build the error the host API answers to an invalid payload.
 * @param {string} message - Error message.
 * @returns {GladysApiError} A 400 BAD_REQUEST error.
 * @example
 * throw badRequest('states[0]: must be an object');
 */
const badRequest = (message) => new GladysApiError(400, 'BAD_REQUEST', message);
const notFound = (message) => new GladysApiError(404, 'NOT_FOUND', message);
const forbidden = (message) => new GladysApiError(403, 'FORBIDDEN', message);

/**
 * @description Derive a selector from a name, like Gladys does (the readable
 * slug when free, then -2, -3…).
 * @param {string} name - The name.
 * @param {Set} taken - The selectors already taken.
 * @returns {string} The selector.
 * @example
 * toSelector('Personal', new Set()); // 'personal'
 */
const toSelector = (name, taken) => {
  const slug =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'calendar';
  let selector = slug;
  for (let suffix = 2; taken.has(selector); suffix += 1) {
    selector = `${slug}-${suffix}`;
  }
  return selector;
};

/**
 * @description Check a POST /discovered_device body like the Gladys core does
 * (main rules of setDiscoveredDevices).
 * @param {string} prefix - External id prefix of the integration: `ext:<selector>:`.
 * @param {any} devices - Published devices.
 * @example
 * validateDiscoveredDevices('ext:demo:', devices);
 */
const validateDiscoveredDevices = (prefix, devices) => {
  if (!Array.isArray(devices)) {
    throw badRequest('devices: must be an array');
  }
  devices.forEach((device, index) => {
    if (device === null || typeof device !== 'object') {
      throw badRequest(`devices[${index}]: must be an object`);
    }
    if (typeof device.name !== 'string' || device.name.length === 0) {
      throw badRequest(`devices[${index}].name: must be a non-empty string`);
    }
    if (typeof device.external_id !== 'string' || !device.external_id.startsWith(prefix)) {
      throw badRequest(`devices[${index}].external_id: must start with "${prefix}"`);
    }
    if (device.poll_frequency !== undefined && !POLL_FREQUENCIES.includes(device.poll_frequency)) {
      throw badRequest(
        `devices[${index}].poll_frequency: invalid poll frequency (milliseconds, one of DEVICE_POLL_FREQUENCIES: ${POLL_FREQUENCIES.join(', ')})`,
      );
    }
    if (!Array.isArray(device.features)) {
      throw badRequest(`devices[${index}].features: must be an array`);
    }
    device.features.forEach((feature, featureIndex) => {
      const featurePath = `devices[${index}].features[${featureIndex}]`;
      if (feature === null || typeof feature !== 'object') {
        throw badRequest(`${featurePath}: must be an object`);
      }
      if (typeof feature.external_id !== 'string' || !feature.external_id.startsWith(prefix)) {
        throw badRequest(`${featurePath}.external_id: must start with "${prefix}"`);
      }
      if (!CATEGORIES.includes(feature.category)) {
        throw badRequest(`${featurePath}.category: unknown category`);
      }
      if (!TYPES.includes(feature.type)) {
        throw badRequest(`${featurePath}.type: unknown type`);
      }
      if (feature.unit !== undefined && feature.unit !== null && !UNITS.includes(feature.unit)) {
        throw badRequest(`${featurePath}.unit: unknown unit`);
      }
    });
  });
};

/**
 * @description Check a POST /state body like the Gladys core does (saveStates).
 * @param {string} prefix - External id prefix of the integration: `ext:<selector>:`.
 * @param {Array} states - Published states.
 * @example
 * validateStates('ext:demo:', states);
 */
const validateStates = (prefix, states) => {
  states.forEach((state, index) => {
    if (state === null || typeof state !== 'object') {
      throw badRequest(`states[${index}]: must be an object`);
    }
    if (typeof state.device_feature_external_id !== 'string' || !state.device_feature_external_id.startsWith(prefix)) {
      throw badRequest(`states[${index}].device_feature_external_id: must start with "${prefix}"`);
    }
    const hasNumericState = typeof state.state === 'number' && Number.isFinite(state.state);
    if (!hasNumericState && typeof state.text !== 'string') {
      throw badRequest(`states[${index}]: must have a numeric "state" or a string "text"`);
    }
    if (
      state.created_at !== undefined &&
      (typeof state.created_at !== 'string' || Number.isNaN(Date.parse(state.created_at)))
    ) {
      throw badRequest(`states[${index}].created_at: must be an ISO 8601 date string`);
    }
  });
};

/**
 * In-memory Gladys behind a fake integration: the data the host API serves,
 * the record of what it received, and Gladys' side of the WebSocket. Exposed
 * as `gladys.fake`.
 */
class FakeGladys {
  /**
   * @description Build the fake Gladys of one fake integration.
   * @param {object} client - The fake integration.
   * @param {object} options - Options of createFakeGladys.
   * @example
   * this.fake = new FakeGladys(this, options);
   */
  constructor(client, options) {
    this.client = client;
    // Data served by the host API — editable at any time by the test.
    this.devices = toWire(options.devices || []);
    this.config = toWire(options.config || {});
    this.houses = toWire(options.houses || []);
    this.containers = toWire(options.containers || []);
    this.contacts = toWire(options.contacts || []);
    this.webhooks = toWire(options.webhooks || { available: false, webhooks: [] });
    this.scanResults = toWire(options.scanResults || {});
    this.linkedUser = toWire(options.linkedUser || { selector: 'john', first_name: 'John', language: 'en' });
    // Calendar integrations: the enabled accounts, the calendars pushed so
    // far (with their user-owned sync/shared flags) and their events.
    this.calendarAccounts = toWire(options.calendarAccounts || []);
    this.calendars = toWire(options.calendars || []);
    this.calendarEvents = toWire(options.calendarEvents || []);
    // Energy contracts capability: the declared tariff calendars (key →
    // entries, presence = declared in the manifest) and the users' contracts.
    this.energyCalendars = toWire(options.energyCalendars || {});
    this.energyContracts = toWire(options.energyContracts || []);
    // The consumption states published after the fact (feature external id →
    // states stamped like the core: the end of a 30-minute interval, the
    // start of a day), fed by publishEnergyConsumption.
    this.energyConsumption = toWire(options.energyConsumption || {});
    this.status = toWire(
      options.status || {
        gladys_version: 'v4.86.0',
        service: { id: 'fake-service-id', selector: client.selector, status: 'RUNNING', version: '1.0.0' },
      },
    );
    // Every host API request received: { method, path, body, status }.
    this.requests = [];
    // Every WebSocket message sent by the integration: { type, payload }.
    this.wsMessages = [];
    this.messageCount = 0;
  }

  /**
   * @description Answer one host API request, like the Gladys core would.
   * @param {string} method - HTTP method.
   * @param {string} path - Path relative to /api/integration/v1.
   * @param {object} [body] - JSON body, as received.
   * @returns {any} The response body.
   * @example
   * fake.route('GET', '/device');
   */
  route(method, fullPath, body) {
    const prefix = `ext:${this.client.selector}:`;
    const [path, search] = fullPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(search || ''));
    if (method === 'GET' && path.startsWith('/energy/calendar/')) {
      return this.readEnergyCalendar(decodeURIComponent(path.slice('/energy/calendar/'.length)), query);
    }
    const containerControl = /^\/container\/([^/]+)\/(start|restart)$/.exec(path);
    if (method === 'POST' && containerControl) {
      // a container seeded (or left) `pulling` simulates the first start of
      // a `manual` entry whose image is missing: 202, then finishPull()
      const name = decodeURIComponent(containerControl[1]);
      const container = this.containers.find((entry) => entry.name === name);
      return container && container.status === 'pulling' ? { success: true, status: 'pulling' } : { success: true };
    }
    switch (`${method} ${path}`) {
      case 'GET /device':
        return this.devices;
      case 'GET /config':
        return { config: this.config };
      case 'POST /config':
        Object.assign(this.config, body.config);
        return { success: true };
      case 'GET /house':
        return this.houses;
      case 'GET /container':
        return { containers: this.containers };
      case 'GET /contact':
        return this.contacts;
      case 'GET /webhook':
        return this.webhooks;
      case 'GET /calendar/account':
        return this.calendarAccounts;
      case 'GET /calendar':
        return this.calendars.filter((calendar) => query.user === undefined || calendar.user === query.user);
      case 'POST /calendar':
        return this.upsertCalendars(body);
      case 'DELETE /calendar':
        return this.deleteCalendar(query.external_id);
      case 'POST /calendar/event':
        return this.upsertCalendarEvents(body);
      case 'POST /energy/calendar':
        return this.upsertEnergyCalendar(body);
      case 'GET /energy/contract':
        return this.energyContracts;
      case 'POST /energy/consumption':
        return this.upsertEnergyConsumption(body);
      case 'GET /status':
        return this.status;
      case 'POST /discovered_device':
        validateDiscoveredDevices(prefix, body.devices);
        return { success: true, count: body.devices.length };
      case 'POST /state':
        validateStates(prefix, body.states);
        return { success: true };
      case 'POST /network_discovery/scan':
        return this.scanResults[body.type] || [];
      case 'POST /contact/link':
        this.contacts = [
          ...this.contacts.filter((contact) => contact.contact_id !== body.contact_id),
          {
            contact_id: body.contact_id,
            contact_name: body.contact_name === undefined ? null : body.contact_name,
            linked_at: new Date().toISOString(),
            user: this.linkedUser,
          },
        ];
        return { user: this.linkedUser };
      default:
        // Every other call (camera image, transports, scene event, message,
        // connection status, containers, wake-on-lan…) is recorded only.
        return { success: true };
    }
  }

  /**
   * @description POST /calendar like the Gladys core: the user must have
   * enabled the integration (404 otherwise), the calendars are upserted by
   * external_id — a new one starts with `sync: true`, `shared: false` and a
   * selector derived from its name; a republished one keeps its user-owned
   * fields and takes the integration-owned ones.
   * @param {object} body - `{ user, calendars }`.
   * @returns {object} `{ success, created, updated }`.
   * @example
   * this.upsertCalendars({ user: 'john', calendars: [] });
   */
  upsertCalendars(body) {
    if (!this.calendarAccounts.some((account) => account.user.selector === body.user)) {
      throw notFound('CALENDAR_ACCOUNT_NOT_FOUND');
    }
    const existingCount = this.calendars.filter((calendar) => calendar.user === body.user).length;
    const newCount = body.calendars.filter(
      (calendar) => !this.calendars.some((existing) => existing.external_id === calendar.external_id),
    ).length;
    if (existingCount + newCount > MAX_CALENDARS_PER_USER) {
      throw badRequest(`calendars: max ${MAX_CALENDARS_PER_USER} calendars per user`);
    }
    let created = 0;
    let updated = 0;
    body.calendars.forEach((calendar) => {
      const existing = this.calendars.find((candidate) => candidate.external_id === calendar.external_id);
      if (existing) {
        existing.name = calendar.name;
        if (calendar.description !== undefined) {
          existing.description = calendar.description;
        }
        if (calendar.color !== undefined) {
          existing.color = calendar.color.toLowerCase();
        }
        updated += 1;
        return;
      }
      const taken = new Set(this.calendars.map((candidate) => candidate.selector));
      this.calendars.push({
        user: body.user,
        external_id: calendar.external_id,
        selector: toSelector(calendar.name, taken),
        name: calendar.name,
        description: calendar.description === undefined ? '' : calendar.description,
        color: calendar.color === undefined ? '#3174ad' : calendar.color.toLowerCase(),
        sync: true,
        shared: false,
      });
      created += 1;
    });
    return { success: true, created, updated };
  }

  /**
   * @description DELETE /calendar like the Gladys core: its own calendars
   * only (404 otherwise), the events go with it.
   * @param {string} externalId - The calendar external_id.
   * @returns {object} `{ success }`.
   * @example
   * this.deleteCalendar('ext:test-integration:john:primary');
   */
  deleteCalendar(externalId) {
    if (!this.calendars.some((calendar) => calendar.external_id === externalId)) {
      throw notFound('CALENDAR_NOT_FOUND');
    }
    this.calendars = this.calendars.filter((calendar) => calendar.external_id !== externalId);
    this.calendarEvents = this.calendarEvents.filter((event) => event.calendar_external_id !== externalId);
    return { success: true };
  }

  /**
   * @description POST /calendar/event like the Gladys core: the calendar
   * must exist and belong to an enabled user (404), `sync: false` refuses
   * the push (403); events are upserted by external_id (an event republished
   * under another calendar of the user is moved), and with a window the
   * integration's events overlapping it and absent from the list are pruned.
   * @param {object} body - `{ calendar_external_id, events, window? }`.
   * @returns {object} `{ success, created, updated, deleted }`.
   * @example
   * this.upsertCalendarEvents({ calendar_external_id: 'ext:test-integration:john:primary', events: [] });
   */
  upsertCalendarEvents(body) {
    const calendar = this.calendars.find((candidate) => candidate.external_id === body.calendar_external_id);
    if (!calendar || !this.calendarAccounts.some((account) => account.user.selector === calendar.user)) {
      throw notFound('CALENDAR_NOT_FOUND');
    }
    if (calendar.sync === false) {
      throw forbidden('CALENDAR_SYNC_DISABLED');
    }
    let deleted = 0;
    if (body.window) {
      const from = Date.parse(body.window.from);
      const to = Date.parse(body.window.to);
      const pushedIds = new Set(body.events.map((event) => event.external_id));
      const overlaps = (event) => {
        const start = Date.parse(event.start);
        const end = event.end === undefined ? undefined : Date.parse(event.end);
        return start < to && ((end !== undefined && end > from) || start >= from);
      };
      body.events.forEach((event, index) => {
        if (!overlaps(event)) {
          throw badRequest(`events[${index}]: must overlap the window`);
        }
      });
      this.calendarEvents = this.calendarEvents.filter((event) => {
        const pruned =
          event.calendar_external_id === body.calendar_external_id &&
          overlaps(event) &&
          !pushedIds.has(event.external_id);
        deleted += pruned ? 1 : 0;
        return !pruned;
      });
    }
    let created = 0;
    let updated = 0;
    body.events.forEach((event) => {
      const index = this.calendarEvents.findIndex((candidate) => candidate.external_id === event.external_id);
      const stored = { calendar_external_id: body.calendar_external_id, ...event };
      if (index === -1) {
        this.calendarEvents.push(stored);
        created += 1;
      } else {
        this.calendarEvents[index] = stored;
        updated += 1;
      }
    });
    return { success: true, created, updated, deleted };
  }

  /**
   * @description POST /energy/calendar like the Gladys core: the key must
   * be declared (a key of `energyCalendars`, 403 otherwise); the entries are
   * upserted by their start (a `date` is read as a UTC midnight here), and
   * the earliest changed one is reported.
   * @param {object} body - `{ calendar_key, entries }`.
   * @returns {object} `{ success, count, changed_from }`.
   * @example
   * this.upsertEnergyCalendar({ calendar_key: 'tempo', entries: [{ date: '2026-01-12', value: 'red' }] });
   */
  upsertEnergyCalendar(body) {
    const entries = this.energyCalendars[body.calendar_key];
    if (entries === undefined) {
      throw forbidden(`calendar "${body.calendar_key}" is not declared by this integration`);
    }
    let changedFrom = null;
    body.entries.forEach((entry) => {
      const startsAt = new Date(
        entry.date === undefined ? entry.starts_at : `${entry.date}T00:00:00.000Z`,
      ).toISOString();
      const value = entry.value === undefined ? entry.price : entry.value;
      const existing = entries.find((candidate) => candidate.starts_at === startsAt);
      if (existing && existing.value === value) {
        return;
      }
      if (existing) {
        existing.value = value;
      } else {
        entries.push({ starts_at: startsAt, value });
      }
      if (changedFrom === null || startsAt < changedFrom) {
        changedFrom = startsAt;
      }
    });
    entries.sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    return { success: true, count: body.entries.length, changed_from: changedFrom };
  }

  /**
   * @description GET /energy/calendar/:key like the Gladys core: a declared
   * key only (403 otherwise), oldest first over the window, the `limit` last
   * entries without one.
   * @param {string} key - The calendar key.
   * @param {object} query - `{ from?, to?, limit? }`.
   * @returns {Array} The entries `[{ starts_at, value }]`.
   * @example
   * this.readEnergyCalendar('tempo', { limit: '1' });
   */
  readEnergyCalendar(key, query) {
    const entries = this.energyCalendars[key];
    if (entries === undefined) {
      throw forbidden(`calendar "${key}" is not declared by this integration`);
    }
    const from = query.from === undefined ? undefined : new Date(query.from).toISOString();
    const to = query.to === undefined ? undefined : new Date(query.to).toISOString();
    const selected = entries.filter(
      (entry) => (from === undefined || entry.starts_at >= from) && (to === undefined || entry.starts_at <= to),
    );
    if (query.limit === undefined) {
      return selected;
    }
    return from === undefined ? selected.slice(-Number(query.limit)) : selected.slice(0, Number(query.limit));
  }

  /**
   * @description POST /energy/consumption like the Gladys core, for what
   * the core still decides once the SDK validated the shapes: the feature
   * must be created by the user — a feature of `devices` (404 otherwise) —
   * and be a 30-minute or daily consumption that the core does not derive
   * from a cumulative index of the same device (400); every interval must
   * be aligned (a 30-minute slot, or a midnight for a daily feature — the
   * fake Gladys runs in UTC, a `date` is read as a UTC midnight), elapsed
   * and at most 5 years old (400). The states are upserted by instant into
   * `energyConsumption` (the end of a 30-minute interval, the start of a
   * day), an unchanged value writes nothing, and the earliest changed one is
   * reported.
   * @param {object} body - `{ device_feature_external_id, intervals }`.
   * @returns {object} `{ success, count, changed_from }`.
   * @example
   * this.upsertEnergyConsumption({ device_feature_external_id: 'ext:demo:m:c', intervals: [{ date: '2026-01-12', kwh: 18.4 }] });
   */
  upsertEnergyConsumption(body) {
    const externalId = body.device_feature_external_id;
    const device = this.devices.find((candidate) =>
      (candidate.features || []).some((feature) => feature.external_id === externalId),
    );
    if (device === undefined) {
      throw notFound(`feature "${externalId}" not found: the device is not created`);
    }
    const feature = device.features.find((candidate) => candidate.external_id === externalId);
    if (
      feature.category !== DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR ||
      !CONSUMPTION_FEATURE_TYPES.includes(feature.type)
    ) {
      throw badRequest('device_feature_external_id: must be a 30-minute or daily consumption feature');
    }
    const derivedFromIndex = device.features.some(
      (candidate) =>
        isEnergyIndexFeature(candidate) &&
        (`${candidate.external_id}_consumption` === externalId ||
          (candidate.id !== undefined && candidate.id === feature.energy_parent_id)),
    );
    if (derivedFromIndex) {
      throw badRequest(
        'device_feature_external_id: this consumption is derived from a cumulative index by the core, publish the index states instead',
      );
    }
    const isDaily = feature.type === DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION;
    const now = Date.now();
    const kwhByInstant = new Map();
    // The shapes (one of starts_at/date, a real YYYY-MM-DD date, a finite
    // kwh >= 0, the batch bound) are the SDK's, checked before any request.
    body.intervals.forEach((interval, index) => {
      let startMs;
      if (interval.date !== undefined) {
        if (!isDaily) {
          throw badRequest(`intervals[${index}].date: a 30-minute consumption takes starts_at`);
        }
        startMs = Date.parse(`${interval.date}T00:00:00.000Z`);
      } else {
        startMs = Date.parse(interval.starts_at);
        if (isDaily && startMs % DAY_MS !== 0) {
          throw badRequest(`intervals[${index}].starts_at: must be a local midnight of UTC`);
        }
        if (!isDaily && startMs % THIRTY_MINUTES_MS !== 0) {
          throw badRequest(`intervals[${index}].starts_at: must be aligned on a 30-minute slot of UTC`);
        }
      }
      const endMs = startMs + (isDaily ? DAY_MS : THIRTY_MINUTES_MS);
      if (startMs < now - ENERGY_CONSUMPTION_PAST_WINDOW_MS) {
        throw badRequest(`intervals[${index}]: starts_at must be at most 5 years ago`);
      }
      if (endMs > now) {
        throw badRequest(`intervals[${index}]: the interval must be elapsed`);
      }
      // the last value given for an instant wins
      kwhByInstant.set(new Date(isDaily ? startMs : endMs).toISOString(), interval.kwh);
    });
    if (this.energyConsumption[externalId] === undefined) {
      this.energyConsumption[externalId] = [];
    }
    const states = this.energyConsumption[externalId];
    let changedFrom = null;
    Array.from(kwhByInstant.keys())
      .sort()
      .forEach((createdAt) => {
        const kwh = kwhByInstant.get(createdAt);
        const existing = states.find((state) => state.created_at === createdAt);
        if (existing && existing.kwh === kwh) {
          return;
        }
        if (existing) {
          existing.kwh = kwh;
        } else {
          states.push({ created_at: createdAt, kwh });
        }
        if (changedFrom === null) {
          changedFrom = createdAt;
        }
      });
    states.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { success: true, count: kwhByInstant.size, changed_from: changedFrom };
  }

  /**
   * @description Bodies of the accepted requests to one endpoint, in order.
   * @param {string} method - HTTP method.
   * @param {string} path - Path relative to /api/integration/v1.
   * @returns {Array} The request bodies.
   * @example
   * fake.bodies('POST', '/state');
   */
  bodies(method, path) {
    return this.requests
      .filter((request) => request.method === method && request.path === path && request.status === 200)
      .map((request) => request.body);
  }

  /** @returns {Array} Every published state: `{ device_feature_external_id, state|text, created_at? }`. */
  get states() {
    return this.bodies('POST', '/state').flatMap((body) => body.states);
  }

  /** @returns {Array} The last published list of discovered devices (each publication replaces the previous one). */
  get discoveredDevices() {
    const bodies = this.bodies('POST', '/discovered_device');
    return bodies.length === 0 ? [] : bodies[bodies.length - 1].devices;
  }

  /** @returns {Array} Every published connection status: `{ connected, message? }`. */
  get connectionStatuses() {
    return this.bodies('POST', '/connection_status');
  }

  /** @returns {object|null} The last published connection status, null if none. */
  get connectionStatus() {
    const statuses = this.connectionStatuses;
    return statuses.length === 0 ? null : statuses[statuses.length - 1];
  }

  /** @returns {Array} Every published transport entry: `{ device_external_id, transport, degraded?, message? }`. */
  get transports() {
    return this.bodies('POST', '/device/transport').flatMap((body) => body.transports);
  }

  /** @returns {Array} Every published camera image: `{ device_external_id, image }`. */
  get cameraImages() {
    return this.bodies('POST', '/camera/image');
  }

  /** @returns {Array} Every fired scene event: `{ key, data }`. */
  get sceneEvents() {
    return this.bodies('POST', '/scene/event');
  }

  /** @returns {Array} Every published channel message: `{ contact_id, text, created_at? }`. */
  get messages() {
    return this.bodies('POST', '/message');
  }

  /** @returns {Array} Every network scan request: `{ type, timeout_seconds?, port?, payload_base64? }`. */
  get scans() {
    return this.bodies('POST', '/network_discovery/scan');
  }

  /** @returns {Array} The key of every widget refresh nudge, in order. */
  get widgetRefreshes() {
    return this.wsMessages
      .filter((message) => message.type === EXTERNAL_INTEGRATION.WIDGET_REFRESH)
      .map((message) => message.payload.key);
  }

  /** @returns {number} The number of weather refresh nudges. */
  get weatherRefreshes() {
    return this.wsMessages.filter((message) => message.type === EXTERNAL_INTEGRATION.WEATHER_REFRESH).length;
  }

  /** @returns {Array} Every published calendar batch: `{ user, calendars }`. */
  get publishedCalendars() {
    return this.bodies('POST', '/calendar');
  }

  /** @returns {Array} Every published event batch: `{ calendar_external_id, events, window? }`. */
  get publishedCalendarEvents() {
    return this.bodies('POST', '/calendar/event');
  }

  /** @returns {Array} The external_id of every deleted calendar, in order. */
  get deletedCalendars() {
    return this.requests
      .filter((request) => request.method === 'DELETE' && request.path === '/calendar' && request.status === 200)
      .map((request) => request.query.external_id);
  }

  /** @returns {Array} Every published energy calendar batch: `{ calendar_key, entries }`. */
  get publishedEnergyCalendars() {
    return this.bodies('POST', '/energy/calendar');
  }

  /** @returns {Array} Every published consumption batch: `{ device_feature_external_id, intervals }`. */
  get publishedEnergyConsumption() {
    return this.bodies('POST', '/energy/consumption');
  }

  /** @returns {number} The number of energy recalculation nudges. */
  get energyRecalculations() {
    return this.wsMessages.filter((message) => message.type === EXTERNAL_INTEGRATION.ENERGY_CALENDAR_REFRESH).length;
  }

  /**
   * @description Last value published for a feature.
   * @param {string} featureExternalId - The feature external_id.
   * @returns {number|string|undefined} Its last `state` (its `text` for a text
   * state), undefined if none was published.
   * @example
   * gladys.fake.lastState(ids.feature('temperature')); // 21.5
   */
  lastState(featureExternalId) {
    const states = this.states.filter((state) => state.device_feature_external_id === featureExternalId);
    if (states.length === 0) {
      return undefined;
    }
    const last = states[states.length - 1];
    return last.text === undefined ? last.state : last.text;
  }

  /**
   * @description Send one WebSocket message to the integration, as Gladys
   * would, and wait for it to be handled. The low-level primitive of the
   * other simulation methods.
   * @param {string} type - Message type (WEBSOCKET_MESSAGE_TYPES).
   * @param {object} [payload] - Message payload; a `message_id` is added.
   * @returns {Promise<object|undefined>} The command ack `{ success, data?, error? }`,
   * or undefined for an event (no ack).
   * @example
   * await gladys.fake.send(WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.SCAN_REQUEST);
   */
  async send(type, payload = {}) {
    this.messageCount += 1;
    const messageId = `fake-message-${this.messageCount}`;
    await this.client._handleMessage(JSON.stringify({ type, payload: { ...payload, message_id: messageId } }));
    const ack = this.wsMessages.find(
      (message) => message.type === EXTERNAL_INTEGRATION.COMMAND_RESULT && message.payload.message_id === messageId,
    );
    if (!ack) {
      return undefined;
    }
    const result = { ...ack.payload };
    delete result.message_id;
    return result;
  }

  // Simulations of Gladys calling the handlers: `fake.<name>(...)` runs the
  // `on<Name>` handler with the same arguments and resolves with the ack.

  /**
   * @description The user actions a feature (onSetValue).
   * @param {object} device - The device.
   * @param {object} deviceFeature - The feature.
   * @param {number|string} value - The value.
   * @returns {Promise<object>} The ack.
   * @example
   * await gladys.fake.setValue(device, device.features[0], 1);
   */
  setValue(device, deviceFeature, value) {
    return this.send(EXTERNAL_INTEGRATION.DEVICE_SET_VALUE, { device, device_feature: deviceFeature, value });
  }

  /**
   * @description The scheduler polls a device (onPoll).
   * @param {object} device - The device.
   * @returns {Promise<object>} The ack.
   * @example
   * await gladys.fake.poll(device);
   */
  poll(device) {
    return this.send(EXTERNAL_INTEGRATION.DEVICE_POLL, { device });
  }

  /**
   * @description Gladys needs a fresh camera image (onGetImage).
   * @param {object} device - The camera device.
   * @returns {Promise<object>} The ack, the image in `data.image`.
   * @example
   * await gladys.fake.getImage(device);
   */
  getImage(device) {
    return this.send(EXTERNAL_INTEGRATION.CAMERA_GET_IMAGE, { device });
  }

  /**
   * @description The user asks for a device scan (onScanRequest).
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.scanRequest();
   */
  scanRequest() {
    return this.send(EXTERNAL_INTEGRATION.SCAN_REQUEST);
  }

  /**
   * @description The user creates a device (onDeviceCreated); it is also
   * added to the devices served by the host API.
   * @param {object} device - The device.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
   */
  deviceCreated(device) {
    this.upsertDevice(device);
    return this.send(EXTERNAL_INTEGRATION.DEVICE_CREATED, { device });
  }

  /**
   * @description The user updates a device (onDeviceUpdated); it is also
   * replaced in the devices served by the host API.
   * @param {object} device - The device.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.deviceUpdated({ ...device, name: 'Renamed' });
   */
  deviceUpdated(device) {
    this.upsertDevice(device);
    return this.send(EXTERNAL_INTEGRATION.DEVICE_UPDATED, { device });
  }

  /**
   * @description The user deletes a device (onDeviceDeleted); it is also
   * removed from the devices served by the host API.
   * @param {object} device - The device.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.deviceDeleted(device);
   */
  deviceDeleted(device) {
    this.devices = this.devices.filter((d) => d.external_id !== device.external_id);
    return this.send(EXTERNAL_INTEGRATION.DEVICE_DELETED, { device });
  }

  /**
   * @description The user saves the configuration form (onConfigUpdated); it
   * also becomes the configuration served by the host API.
   * @param {object} config - The complete new configuration values.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.configUpdated({ api_key: 'new-key' });
   */
  configUpdated(config) {
    this.config = toWire(config);
    return this.send(EXTERNAL_INTEGRATION.CONFIG_UPDATED, { config });
  }

  /**
   * @description End the image download of a sub-container seeded with
   * `status: 'pulling'` (first start of a `manual` entry): it becomes
   * `running`, or `stopped` with `last_error` when the download or the start
   * failed — a startContainer / restartContainer waiting for it then
   * resolves or rejects with that code.
   * @param {string} name - Sub-container name.
   * @param {object} [options] - Options.
   * @param {string} [options.lastError] - Failure code, e.g. 'UNABLE_TO_PULL_IMAGE'.
   * @example
   * gladys.fake.finishPull('frigate');
   */
  finishPull(name, { lastError } = {}) {
    const container = this.containers.find((entry) => entry.name === name);
    if (!container) {
      throw new Error(`finishPull: no sub-container named ${name} in fake.containers`);
    }
    container.status = lastError ? 'stopped' : 'running';
    container.pull = null;
    container.last_error = lastError || null;
  }

  /**
   * @description The user changes the hardware grants (onHardwareUpdated).
   * @param {Array} containers - `[{ name, devices: [{ class, granted, available }] }]`.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.hardwareUpdated([{ name: 'frigate', devices: [] }]);
   */
  hardwareUpdated(containers) {
    return this.send(EXTERNAL_INTEGRATION.HARDWARE_UPDATED, { containers });
  }

  /**
   * @description The user clicks "Connect" on an oauth2/account_link field (onOAuthAuthorizeUrl).
   * @param {string} key - Config field key.
   * @param {string} [redirectUri] - Redirect URI (undefined for account_link).
   * @returns {Promise<object>} The ack, the URL in `data.authorize_url`.
   * @example
   * await gladys.fake.oauthAuthorizeUrl('account', 'https://gladys.local/oauth');
   */
  oauthAuthorizeUrl(key, redirectUri) {
    return this.send(EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL, { key, redirect_uri: redirectUri });
  }

  /**
   * @description The OAuth2 provider redirects back (onOAuthCallback).
   * @param {string} key - Config field key.
   * @param {object} params - `{ code, state, redirectUri }`.
   * @returns {Promise<object>} The ack.
   * @example
   * await gladys.fake.oauthCallback('account', { code: 'abc', state: 'xyz', redirectUri });
   */
  oauthCallback(key, { code, state, redirectUri } = {}) {
    return this.send(EXTERNAL_INTEGRATION.OAUTH_CALLBACK, { key, code, state, redirect_uri: redirectUri });
  }

  /**
   * @description Gladys delivers a message in the channel (onSendMessage).
   * @param {object} contact - The resolved contact identity.
   * @param {object} message - `{ text, file }`.
   * @returns {Promise<object>} The ack.
   * @example
   * await gladys.fake.sendMessage({ id: '12345' }, { text: 'Hello', file: null });
   */
  sendMessage(contact, message) {
    return this.send(EXTERNAL_INTEGRATION.MESSAGE_SEND, { contact, message });
  }

  /**
   * @description Gladys asks for the weather (onWeatherGet).
   * @param {object} options - `{ latitude, longitude, language, units }`.
   * @returns {Promise<object>} The ack, the weather in `data.weather`.
   * @example
   * await gladys.fake.weatherGet({ latitude: 48.8, longitude: 2.3, language: 'en', units: 'metric' });
   */
  weatherGet(options) {
    return this.send(EXTERNAL_INTEGRATION.WEATHER_GET, { options });
  }

  /**
   * @description Gladys asks for a weather provider image (onWeatherGetImage).
   * @param {string} key - Image key.
   * @returns {Promise<object>} The ack, the image in `data.image`.
   * @example
   * await gladys.fake.weatherGetImage('vigilance-map');
   */
  weatherGetImage(key) {
    return this.send(EXTERNAL_INTEGRATION.WEATHER_GET_IMAGE, { key });
  }

  /**
   * @description Gladys Plus relays a webhook call (onWebhook).
   * @param {string} key - Webhook key.
   * @param {object} [request] - `{ method, query, body, contentType }`.
   * @param {object} [options] - Options.
   * @param {string} [options.mode] - 'fire_and_forget' (default, no ack) or 'sync'.
   * @returns {Promise<object|undefined>} The ack in sync mode.
   * @example
   * await gladys.fake.webhook('events', { method: 'POST', body: '{}' });
   */
  webhook(key, request = {}, { mode = 'fire_and_forget' } = {}) {
    const type = mode === 'sync' ? EXTERNAL_INTEGRATION.WEBHOOK_REQUEST : EXTERNAL_INTEGRATION.WEBHOOK_RECEIVED;
    return this.send(type, {
      webhook_key: key,
      method: request.method,
      query: request.query,
      body: request.body,
      content_type: request.contentType,
    });
  }

  /**
   * @description The Gladys Plus webhook availability changes
   * (onWebhookUpdated); it also becomes the state served by getWebhooks.
   * @param {object} webhooks - `{ available, webhooks: [{ key, mode, url }] }`.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * await gladys.fake.webhookUpdated({ available: false, webhooks: [] });
   */
  webhookUpdated(webhooks) {
    this.webhooks = toWire(webhooks);
    return this.send(EXTERNAL_INTEGRATION.WEBHOOK_UPDATED, webhooks);
  }

  /**
   * @description The user clicks a manifest action button (onAction).
   * @param {string} key - Action key.
   * @param {object} [fields] - Values of the action fields.
   * @returns {Promise<object>} The ack, the message in `data.message`.
   * @example
   * await gladys.fake.action('test_connection', {});
   */
  action(key, fields = {}) {
    return this.send(EXTERNAL_INTEGRATION.ACTION_RUN, { key, fields });
  }

  /**
   * @description A scene reaches one of the integration scene actions (onSceneAction).
   * @param {string} key - Scene action key.
   * @param {object} [fields] - Resolved fields.
   * @returns {Promise<object>} The ack, the outputs in `data.outputs`.
   * @example
   * await gladys.fake.sceneAction('create_snapshot', { camera: ids.device });
   */
  sceneAction(key, fields = {}) {
    return this.send(EXTERNAL_INTEGRATION.SCENE_ACTION_RUN, { key, fields });
  }

  /**
   * @description A dashboard shows a widget (onWidgetGet).
   * @param {string} key - Widget key.
   * @param {object} [options] - `{ settings, language, units }`.
   * @returns {Promise<object>} The ack, the content in `data.content`.
   * @example
   * await gladys.fake.widgetGet('vacuum', { settings: {}, language: 'en', units: 'metric' });
   */
  widgetGet(key, { settings = {}, language = 'en', units = 'metric' } = {}) {
    return this.send(EXTERNAL_INTEGRATION.WIDGET_GET, { key, settings, language, units });
  }

  /**
   * @description Gladys needs the bytes of a widget image (onWidgetGetImage).
   * @param {string} imageKey - Image key.
   * @returns {Promise<object>} The ack, the image in `data.image`.
   * @example
   * await gladys.fake.widgetGetImage('poster-1');
   */
  widgetGetImage(imageKey) {
    return this.send(EXTERNAL_INTEGRATION.WIDGET_GET_IMAGE, { image_key: imageKey });
  }

  /**
   * @description The user taps a widget button (onWidgetAction).
   * @param {string} key - Widget key.
   * @param {string} actionKey - Action key of the button.
   * @param {object} [params] - Params declared in the content.
   * @param {object} [options] - `{ settings, values }` — `values` only for a
   * button declaring `fields` (the typed form, validated by the core).
   * @returns {Promise<object>} The ack, the message in `data.message`.
   * @example
   * await gladys.fake.widgetAction('vacuum', 'start', {}, { settings: {} });
   * @example
   * await gladys.fake.widgetAction('pellets', 'delivery', {}, { values: { bags: 72 } });
   */
  widgetAction(key, actionKey, params = {}, { settings = {}, values } = {}) {
    const payload = { key, action_key: actionKey, params, settings };
    if (values !== undefined) {
      payload.values = values;
    }
    return this.send(EXTERNAL_INTEGRATION.WIDGET_ACTION, payload);
  }

  /**
   * @description A user enabled or disabled a calendar integration, changed
   * their account values or toggled a calendar (onCalendarAccountUpdated).
   * The data served by the host API is NOT changed: set `calendarAccounts`
   * and `calendars` yourself to what the user did before calling it.
   * @param {string} userSelector - The user selector.
   * @returns {Promise<void>} Resolves once handled.
   * @example
   * gladys.fake.calendarAccounts.push({ user: { selector: 'john', first_name: 'John', language: 'en' }, config: {} });
   * await gladys.fake.calendarAccountUpdated('john');
   */
  calendarAccountUpdated(userSelector) {
    return this.send(EXTERNAL_INTEGRATION.CALENDAR_ACCOUNT_UPDATED, { user: userSelector });
  }

  /**
   * @description Gladys asks a delegated energy contract provider to price
   * the intervals of a billing period (onEnergyPrice).
   * @param {object} request - `{ contract, billing_period, cumulative_before, intervals }`.
   * @returns {Promise<object>} The ack, the costs in `data.costs`.
   * @example
   * await gladys.fake.energyPrice({ contract, billing_period, cumulative_before, intervals });
   */
  energyPrice(request) {
    return this.send(EXTERNAL_INTEGRATION.ENERGY_CONTRACT_PRICE, request);
  }

  /**
   * @description Gladys asks a delegated energy contract provider for the
   * current price (onEnergyCurrent).
   * @param {object} request - `{ contract, billing_period, cumulative, max_power_kw }`.
   * @returns {Promise<object>} The ack, the price in `data`.
   * @example
   * await gladys.fake.energyCurrent({ contract, billing_period, cumulative, max_power_kw: 2 });
   */
  energyCurrent(request) {
    return this.send(EXTERNAL_INTEGRATION.ENERGY_CONTRACT_CURRENT, request);
  }

  /**
   * @description The supervisor stops the container: run the handleShutdown
   * cleanup (if registered) with the signal, then disconnect — without
   * exiting the process. Like in production, the client disconnects even
   * when the cleanup throws; unlike production, which only logs it, the
   * cleanup error then rejects so the test sees it.
   * @param {string} [signal] - 'SIGTERM' (default) or 'SIGINT'.
   * @returns {Promise<void>} Resolves once shut down.
   * @example
   * await gladys.fake.shutdown();
   */
  async shutdown(signal = 'SIGTERM') {
    try {
      if (this.client.shutdownCleanup) {
        await this.client.shutdownCleanup(signal);
      }
    } finally {
      await this.client.disconnect();
    }
  }

  /**
   * @description Insert or replace a device in the devices served by the host API.
   * @param {object} device - The device.
   * @example
   * this.upsertDevice(device);
   */
  upsertDevice(device) {
    this.devices = [...this.devices.filter((d) => d.external_id !== device.external_id), toWire(device)];
  }
}

/**
 * GladysIntegration bound to an in-memory FakeGladys instead of the network.
 */
class FakeGladysIntegration extends GladysIntegration {
  /**
   * @description Build the fake integration client.
   * @param {object} options - Options of createFakeGladys.
   * @example
   * new FakeGladysIntegration({ selector: 'demo' });
   */
  constructor(options) {
    super({
      // .invalid never resolves: nothing can leave the process by mistake.
      hostApiUrl: 'http://fake-gladys.invalid',
      token: 'fake-integration-token',
      selector: options.selector || 'test-integration',
      logger: options.logger || createLogger({ level: 'silent' }),
    });
    this.shutdownCleanup = null;
    // a download simulated with finishPull() is seen on the next tick
    this.containerPullPollInterval = 0;
    this.fake = new FakeGladys(this, options);
    const { fake } = this;
    const request = async (method, fullPath, body) => {
      const wireBody = toWire(body);
      // The query string (a DELETE target, a filter) is recorded apart from
      // the path, and only when there is one.
      const [path, search] = fullPath.split('?');
      const record = { method, path, body: wireBody, status: 200 };
      if (search !== undefined) {
        record.query = Object.fromEntries(new URLSearchParams(search));
      }
      fake.requests.push(record);
      try {
        return toWire(fake.route(method, fullPath, wireBody));
      } catch (e) {
        record.status = e.status;
        throw e;
      }
    };
    this.httpClient = {
      get: (path) => request('GET', path),
      post: (path, body) => request('POST', path, body),
      delete: (path) => request('DELETE', path),
    };
  }

  /**
   * @description Resynchronize from the fake Gladys (GET /device + GET /config),
   * mark the client connected, then emit 'connected' and wait for its
   * listeners — so a test can assert what they published right after
   * `await gladys.connect()`.
   * @returns {Promise<void>} Resolves once the 'connected' listeners settled.
   * @example
   * await gladys.connect();
   */
  async connect() {
    await this.getDevices();
    await this.getConfig();
    this.connected = true;
    await this._emitAndWait('connected');
  }

  /**
   * @description Mark the client disconnected, then emit 'disconnected' and
   * wait for its listeners.
   * @returns {Promise<void>} Resolves once the 'disconnected' listeners settled.
   * @example
   * await gladys.disconnect();
   */
  async disconnect() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    await this._emitAndWait('disconnected');
  }

  /**
   * @description Remember the cleanup for `gladys.fake.shutdown()` instead of
   * listening to the process signals.
   * @param {Function} [cleanup] - `(signal) => Promise`.
   * @example
   * gladys.handleShutdown(async () => stopPolling());
   */
  handleShutdown(cleanup) {
    this.shutdownCleanup = cleanup || null;
  }

  /**
   * @description Call the listeners of an event and wait for the promises
   * they return (an async listener error rejects).
   * @param {string} event - Event name.
   * @returns {Promise<void>} Resolves once every listener settled.
   * @example
   * await this._emitAndWait('connected');
   */
  async _emitAndWait(event) {
    await Promise.all(this.rawListeners(event).map((listener) => listener.call(this)));
  }

  /**
   * @description Run an event handler, letting its error reject — the real
   * client swallows it (events have no ack), a test wants to see it.
   * @param {string} name - Handler name.
   * @param {Array} args - Arguments passed to the handler.
   * @example
   * await this._runHandler('scanRequest', []);
   */
  async _runHandler(name, args) {
    const handler = this.handlers[name];
    if (handler) {
      await handler(...args);
    }
  }

  /**
   * @description Record an outgoing WebSocket message (command acks, refresh
   * nudges), connected or not.
   * @param {string} type - Message type.
   * @param {object} payload - Message payload.
   * @example
   * this._send('external-integration.widget.refresh', { key: 'vacuum' });
   */
  _send(type, payload) {
    this.fake.wsMessages.push({ type, payload: toWire(payload) });
  }
}

/**
 * @description Create a fake Gladys for the integration's unit tests: a real
 * GladysIntegration (same methods, same checks, same payload mapping) bound
 * to an in-memory Gladys instead of the network. Pass it to the code under
 * test in place of `new GladysIntegration()`. `gladys.fake` holds the data
 * the host API serves, the record of what Gladys received and the
 * simulations of Gladys' calls (`gladys.fake.poll(device)` runs the onPoll
 * handler and resolves with its ack, and so on for every handler).
 * @param {object} [options] - Options.
 * @param {string} [options.selector] - Integration selector (default: 'test-integration').
 * @param {Array} [options.devices] - Devices created by the user (GET /device).
 * @param {object} [options.config] - Configuration values (GET /config).
 * @param {Array} [options.houses] - Houses (GET /house).
 * @param {Array} [options.containers] - Sub-containers (GET /container).
 * @param {Array} [options.contacts] - Linked contacts (GET /contact).
 * @param {object} [options.webhooks] - Webhook state (GET /webhook).
 * @param {object} [options.scanResults] - Raw results per scan type, e.g. `{ mdns: [...] }`.
 * @param {object} [options.linkedUser] - User returned by linkContact.
 * @param {Array} [options.calendarAccounts] - Users who enabled a calendar integration (GET /calendar/account).
 * @param {Array} [options.calendars] - Calendars already pushed (GET /calendar), with their `sync`/`shared` flags.
 * @param {Array} [options.calendarEvents] - Events already pushed, each with its `calendar_external_id`.
 * @param {object} [options.energyCalendars] - Declared tariff calendars: key → entries `[{ starts_at, value }]`.
 * @param {Array} [options.energyContracts] - Contracts referencing the integration templates (GET /energy/contract).
 * @param {object} [options.energyConsumption] - Consumption states already published after the fact: feature external id → `[{ created_at, kwh }]`.
 * @param {object} [options.status] - GET /status response.
 * @param {object} [options.logger] - SDK logger (default: silent).
 * @returns {GladysIntegration} The fake integration client, with `fake`.
 * @example
 * const gladys = createFakeGladys({ config: { api_key: 'key' } });
 * registerHandlers(gladys); // your code
 * await gladys.connect();
 * await gladys.fake.poll(device);
 * assert.equal(gladys.fake.lastState(ids.feature('temperature')), 21.5);
 */
const createFakeGladys = (options = {}) => new FakeGladysIntegration(options);

module.exports = { createFakeGladys };
