const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { describe, it } = require('node:test');

const {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
  GladysApiError,
  GladysIntegration,
  WEBSOCKET_MESSAGE_TYPES,
  createLogger,
} = require('../lib');
const { createFakeGladys } = require('../lib/testing');

const { EXTERNAL_INTEGRATION } = WEBSOCKET_MESSAGE_TYPES;

/** A valid discovered device of the 'test-integration' selector. */
const sensor = (overrides = {}) => ({
  name: 'Sensor',
  external_id: 'ext:test-integration:sensor:1',
  should_poll: true,
  poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
  features: [
    {
      name: 'Temperature',
      external_id: 'ext:test-integration:sensor:1:temperature',
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      read_only: true,
    },
  ],
  ...overrides,
});

/** Assert that a promise rejects with the 400 the host API answers. */
const rejectsWith400 = (promise, message) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof GladysApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'BAD_REQUEST');
    assert.match(error.message, message);
    return true;
  });

describe('createFakeGladys(options?)', () => {
  describe('the fake integration client', () => {
    it('should be a real GladysIntegration with the default test selector', () => {
      const gladys = createFakeGladys();
      assert.ok(gladys instanceof GladysIntegration);
      assert.equal(gladys.selector, 'test-integration');
      assert.equal(gladys.connected, false);
      assert.deepEqual(gladys.externalIds('plug', 'abc').feature('power'), 'ext:test-integration:plug:abc:power');
    });

    it('should accept a selector and a logger', () => {
      const logger = createLogger({ level: 'silent' });
      const gladys = createFakeGladys({ selector: 'weather', logger });
      assert.equal(gladys.externalId('station'), 'ext:weather:station');
      assert.equal(gladys.logger, logger);
    });

    it('should keep the real argument checks of the SDK', async () => {
      const gladys = createFakeGladys();
      await assert.rejects(gladys.publishStates({}), /must be an array/);
      await assert.rejects(gladys.publishSceneEvent('motion', { nested: {} }), /flat/);
      assert.throws(() => gladys.requestWidgetRefresh('Bad Key'), /widget key/);
      assert.equal(gladys.fake.requests.length, 0);
    });

    it('should copy the options, so the test data stays untouched', async () => {
      const houses = [{ id: 'house-1', name: 'Home', selector: 'home', latitude: 48.8, longitude: 2.3 }];
      const gladys = createFakeGladys({ houses });
      const received = await gladys.getHouses();
      received[0].name = 'Changed';
      assert.equal(houses[0].name, 'Home');
      assert.equal(gladys.fake.houses[0].name, 'Home');
    });
  });

  describe('connect() / disconnect()', () => {
    it('should resynchronize the devices and the config, then emit connected', async () => {
      const device = { external_id: 'ext:test-integration:sensor:1', name: 'Sensor' };
      const gladys = createFakeGladys({ devices: [device], config: { api_key: 'key' } });
      const connected = once(gladys, 'connected');
      await gladys.connect();
      await connected;
      assert.equal(gladys.connected, true);
      assert.deepEqual(gladys.devices, [device]);
      assert.deepEqual(gladys.config, { api_key: 'key' });
      assert.deepEqual(
        gladys.fake.requests.map(({ method, path }) => `${method} ${path}`),
        ['GET /device', 'GET /config'],
      );
    });

    it('should wait for the async connected listeners', async () => {
      const gladys = createFakeGladys();
      gladys.on('connected', async () => {
        await delay(5);
        await gladys.publishDiscoveredDevices([sensor()]);
      });
      await gladys.connect();
      assert.equal(gladys.fake.discoveredDevices.length, 1);
    });

    it('should run a once listener only once', async () => {
      const gladys = createFakeGladys();
      let calls = 0;
      gladys.once('connected', () => {
        calls += 1;
      });
      await gladys.connect();
      await gladys.disconnect();
      await gladys.connect();
      assert.equal(calls, 1);
    });

    it('should reject when a connected listener fails', async () => {
      const gladys = createFakeGladys();
      gladys.on('connected', async () => {
        throw new Error('init failed');
      });
      await assert.rejects(gladys.connect(), /init failed/);
    });

    it('should mark the client disconnected and wait for the disconnected listeners', async () => {
      const gladys = createFakeGladys();
      let stopped = false;
      gladys.on('disconnected', async () => {
        await delay(5);
        stopped = true;
      });
      await gladys.connect();
      await gladys.disconnect();
      assert.equal(gladys.connected, false);
      assert.equal(stopped, true);
    });

    it('should not emit disconnected when not connected', async () => {
      const gladys = createFakeGladys();
      let emitted = false;
      gladys.on('disconnected', () => {
        emitted = true;
      });
      await gladys.disconnect();
      assert.equal(emitted, false);
    });
  });

  describe('host API record', () => {
    it('should record the published states and give the last value of a feature', async () => {
      const gladys = createFakeGladys();
      const temperature = 'ext:test-integration:sensor:1:temperature';
      const status = 'ext:test-integration:sensor:1:status';
      const createdAt = new Date('2026-10-09T08:00:00.000Z');
      await gladys.publishState(temperature, 21.5);
      await gladys.publishState(temperature, { state: 20, created_at: createdAt });
      await gladys.publishStates([{ device_feature_external_id: status, text: 'idle' }]);
      assert.deepEqual(gladys.fake.states, [
        { device_feature_external_id: temperature, state: 21.5 },
        // What Gladys receives: the Date is serialized.
        { device_feature_external_id: temperature, state: 20, created_at: '2026-10-09T08:00:00.000Z' },
        { device_feature_external_id: status, text: 'idle' },
      ]);
      assert.equal(gladys.fake.lastState(temperature), 20);
      assert.equal(gladys.fake.lastState(status), 'idle');
      assert.equal(gladys.fake.lastState('ext:test-integration:unknown'), undefined);
    });

    it('should keep the last published list of discovered devices', async () => {
      const gladys = createFakeGladys();
      assert.deepEqual(gladys.fake.discoveredDevices, []);
      assert.deepEqual(
        await gladys.publishDiscoveredDevices([sensor(), sensor({ external_id: 'ext:test-integration:sensor:2' })]),
        {
          success: true,
          count: 2,
        },
      );
      await gladys.publishDiscoveredDevices([sensor()]);
      assert.deepEqual(gladys.fake.discoveredDevices, [sensor()]);
    });

    it('should record the connection statuses', async () => {
      const gladys = createFakeGladys();
      assert.equal(gladys.fake.connectionStatus, null);
      await gladys.setConnectionStatus(false, { en: 'Token expired' });
      await gladys.setConnectionStatus(true);
      assert.deepEqual(gladys.fake.connectionStatuses, [
        { connected: false, message: { en: 'Token expired' } },
        { connected: true },
      ]);
      assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
    });

    it('should record the transports, camera images, scene events and channel messages', async () => {
      const gladys = createFakeGladys();
      const plug = gladys.externalId('plug:abc');
      await gladys.publishTransports([
        { external_id: plug, transport: 'cloud', degraded: true, message: { en: 'Fallback' } },
      ]);
      await gladys.publishCameraImage(gladys.externalId('cam:1'), 'image/jpg;base64,AAAA');
      await gladys.publishSceneEvent('doorbell_pressed', { door: 'front' });
      await gladys.publishMessage('12345', 'Hello', { createdAt: new Date('2026-10-09T08:00:00.000Z') });
      assert.deepEqual(gladys.fake.transports, [
        { device_external_id: plug, transport: 'cloud', degraded: true, message: { en: 'Fallback' } },
      ]);
      assert.deepEqual(gladys.fake.cameraImages, [
        { device_external_id: 'ext:test-integration:cam:1', image: 'image/jpg;base64,AAAA' },
      ]);
      assert.deepEqual(gladys.fake.sceneEvents, [{ key: 'doorbell_pressed', data: { door: 'front' } }]);
      assert.deepEqual(gladys.fake.messages, [
        { contact_id: '12345', text: 'Hello', created_at: '2026-10-09T08:00:00.000Z' },
      ]);
    });

    it('should answer the scans with the scan results of their type', async () => {
      const mdns = [
        { name: 'Eve._hap._tcp.local', host: 'eve.local', addresses: ['192.168.1.20'], port: 80, txt: ['id=AA'] },
      ];
      const gladys = createFakeGladys({ scanResults: { mdns } });
      assert.deepEqual(await gladys.scanNetwork('mdns', { timeoutSeconds: 5 }), mdns);
      assert.deepEqual(await gladys.scanNetwork('ssdp'), []);
      assert.deepEqual(gladys.fake.scans, [{ type: 'mdns', timeout_seconds: 5 }, { type: 'ssdp' }]);
    });

    it('should record the refresh nudges, connected or not', () => {
      const gladys = createFakeGladys();
      gladys.requestWidgetRefresh('vacuum');
      gladys.requestWidgetRefresh('energy');
      gladys.requestWeatherRefresh();
      assert.deepEqual(gladys.fake.widgetRefreshes, ['vacuum', 'energy']);
      assert.equal(gladys.fake.weatherRefreshes, 1);
      assert.deepEqual(gladys.fake.wsMessages[0], {
        type: EXTERNAL_INTEGRATION.WIDGET_REFRESH,
        payload: { key: 'vacuum' },
      });
    });

    it('should serve the data given as options', async () => {
      const house = { id: 'house-1', name: 'Home', selector: 'home', latitude: null, longitude: null };
      const container = { name: 'mqtt', status: 'running', ports: [], devices: [] };
      const contact = { contact_id: '1', contact_name: 'John', linked_at: '2026-10-09T08:00:00.000Z', user: {} };
      const webhooks = { available: true, webhooks: [{ key: 'events', mode: 'fire_and_forget', url: 'https://x' }] };
      const status = {
        gladys_version: 'v4.90.0',
        service: { id: 'id', selector: 's', status: 'RUNNING', version: '2.0.0' },
      };
      const gladys = createFakeGladys({
        houses: [house],
        containers: [container],
        contacts: [contact],
        webhooks,
        status,
      });
      assert.deepEqual(await gladys.getHouses(), [house]);
      assert.deepEqual(await gladys.getContainers(), [container]);
      assert.deepEqual(await gladys.getContacts(), [contact]);
      assert.deepEqual(await gladys.getWebhooks(), webhooks);
      assert.deepEqual(await gladys.getStatus(), status);
    });

    it('should serve empty data and a running status by default', async () => {
      const gladys = createFakeGladys();
      assert.deepEqual(await gladys.getHouses(), []);
      assert.deepEqual(await gladys.getContainers(), []);
      assert.deepEqual(await gladys.getContacts(), []);
      assert.deepEqual(await gladys.getWebhooks(), { available: false, webhooks: [] });
      assert.deepEqual(await gladys.getConfig(), {});
      const { service } = await gladys.getStatus();
      assert.equal(service.selector, 'test-integration');
      assert.equal(service.status, 'RUNNING');
    });

    it('should merge setConfig into the served config', async () => {
      const gladys = createFakeGladys({ config: { api_key: 'key' } });
      await gladys.setConfig({ token: 'secret' });
      assert.deepEqual(gladys.fake.config, { api_key: 'key', token: 'secret' });
      assert.deepEqual(await gladys.getConfig(), { api_key: 'key', token: 'secret' });
    });

    it('should link any code to the linked user and list the contact', async () => {
      const linkedUser = { selector: 'jane', first_name: 'Jane', language: 'fr' };
      const gladys = createFakeGladys({ linkedUser });
      assert.deepEqual(await gladys.linkContact('CODE', '12345', 'Jane D.'), linkedUser);
      await gladys.linkContact('CODE', '12345');
      const contacts = await gladys.getContacts();
      assert.equal(contacts.length, 1);
      assert.equal(contacts[0].contact_id, '12345');
      assert.equal(contacts[0].contact_name, null);
      assert.deepEqual(contacts[0].user, linkedUser);
      assert.equal(typeof contacts[0].linked_at, 'string');
    });

    it('should serve the calendar accounts and calendars, and filter the calendars by user', async () => {
      const account = { user: { selector: 'john', first_name: 'John', language: 'en' }, config: { url: 'x' } };
      const calendars = [
        {
          user: 'john',
          external_id: 'ext:test-integration:john:a',
          selector: 'a',
          name: 'A',
          description: '',
          color: '#3174ad',
          sync: true,
          shared: false,
        },
        {
          user: 'jane',
          external_id: 'ext:test-integration:jane:b',
          selector: 'b',
          name: 'B',
          description: '',
          color: '#3174ad',
          sync: false,
          shared: true,
        },
      ];
      const gladys = createFakeGladys({ calendarAccounts: [account], calendars });
      assert.deepEqual(await gladys.getCalendarAccounts(), [account]);
      assert.deepEqual(await gladys.getCalendars(), calendars);
      assert.deepEqual(await gladys.getCalendars('jane'), [calendars[1]]);
      assert.deepEqual(gladys.fake.requests[2], {
        method: 'GET',
        path: '/calendar',
        body: undefined,
        query: { user: 'jane' },
        status: 200,
      });
      assert.deepEqual(await createFakeGladys().getCalendarAccounts(), []);
    });

    it('should upsert the published calendars of an enabled user like Gladys, and refuse the others', async () => {
      const gladys = createFakeGladys({
        calendarAccounts: [{ user: { selector: 'john', first_name: 'John', language: 'en' }, config: {} }],
      });
      const primary = gladys.externalId('john:primary');
      assert.deepEqual(
        await gladys.publishCalendars('john', [
          { external_id: primary, name: 'Personal' },
          { external_id: gladys.externalId('john:family'), name: 'Personal', description: 'Shared', color: '#FF0000' },
          { external_id: gladys.externalId('john:emoji'), name: '📅' },
        ]),
        { success: true, created: 3, updated: 0 },
      );
      assert.deepEqual(await gladys.getCalendars('john'), [
        {
          user: 'john',
          external_id: primary,
          selector: 'personal',
          name: 'Personal',
          description: '',
          color: '#3174ad',
          sync: true,
          shared: false,
        },
        {
          user: 'john',
          external_id: 'ext:test-integration:john:family',
          selector: 'personal-2',
          name: 'Personal',
          description: 'Shared',
          color: '#ff0000',
          sync: true,
          shared: false,
        },
        {
          user: 'john',
          external_id: 'ext:test-integration:john:emoji',
          selector: 'calendar',
          name: '📅',
          description: '',
          color: '#3174ad',
          sync: true,
          shared: false,
        },
      ]);
      // A republication overwrites the integration-owned fields only.
      gladys.fake.calendars[0].sync = false;
      gladys.fake.calendars[0].shared = true;
      assert.deepEqual(
        await gladys.publishCalendars('john', [
          { external_id: primary, name: 'Perso', description: 'Mine', color: '#00FF00' },
        ]),
        { success: true, created: 0, updated: 1 },
      );
      assert.deepEqual(gladys.fake.calendars[0], {
        user: 'john',
        external_id: primary,
        selector: 'personal',
        name: 'Perso',
        description: 'Mine',
        color: '#00ff00',
        sync: false,
        shared: true,
      });
      await gladys.publishCalendars('john', [{ external_id: primary, name: 'Personal' }]);
      assert.equal(gladys.fake.calendars[0].description, 'Mine');
      assert.deepEqual(gladys.fake.publishedCalendars.length, 3);
      await assert.rejects(
        gladys.publishCalendars('bob', [{ external_id: gladys.externalId('bob:p'), name: 'P' }]),
        (error) => {
          assert.ok(error instanceof GladysApiError);
          assert.equal(error.status, 404);
          assert.equal(error.message, 'CALENDAR_ACCOUNT_NOT_FOUND');
          return true;
        },
      );
      await rejectsWith400(
        gladys.publishCalendars(
          'john',
          Array.from({ length: 48 }, (_, i) => ({ external_id: gladys.externalId(`john:${i}`), name: `C${i}` })),
        ),
        /max 50 calendars per user/,
      );
    });

    it('should delete a calendar and its events, and refuse an unknown one', async () => {
      const gladys = createFakeGladys({
        calendarAccounts: [{ user: { selector: 'john', first_name: 'John', language: 'en' }, config: {} }],
      });
      const primary = gladys.externalId('john:primary');
      await gladys.publishCalendars('john', [{ external_id: primary, name: 'Personal' }]);
      await gladys.publishCalendarEvents(primary, [
        { external_id: gladys.externalId('john:e1'), name: 'E1', start: '2026-08-14T09:00:00Z' },
      ]);
      assert.deepEqual(await gladys.deleteCalendar(primary), { success: true });
      assert.deepEqual(gladys.fake.calendars, []);
      assert.deepEqual(gladys.fake.calendarEvents, []);
      assert.deepEqual(gladys.fake.deletedCalendars, [primary]);
      await assert.rejects(gladys.deleteCalendar(primary), (error) => {
        assert.equal(error.status, 404);
        return true;
      });
    });

    it('should upsert, move and prune the published events like Gladys', async () => {
      const gladys = createFakeGladys({
        calendarAccounts: [{ user: { selector: 'john', first_name: 'John', language: 'en' }, config: {} }],
      });
      const primary = gladys.externalId('john:primary');
      const work = gladys.externalId('john:work');
      await gladys.publishCalendars('john', [
        { external_id: primary, name: 'Personal' },
        { external_id: work, name: 'Work' },
      ]);
      const event = (id, start, end) => ({ external_id: gladys.externalId(`john:${id}`), name: id, start, end });
      assert.deepEqual(
        await gladys.publishCalendarEvents(primary, [
          event('a', '2026-08-14T09:00:00.000Z', '2026-08-14T10:00:00.000Z'),
          event('b', '2026-08-20T09:00:00.000Z'),
          event('c', '2026-09-02T09:00:00.000Z'),
        ]),
        { success: true, created: 3, updated: 0, deleted: 0 },
      );
      // A window prunes the integration's events overlapping it and absent from the list.
      assert.deepEqual(
        await gladys.publishCalendarEvents(
          primary,
          [event('a', '2026-08-14T09:30:00.000Z', '2026-08-14T10:00:00.000Z'), event('d', '2026-08-31T23:00:00.000Z')],
          { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
        ),
        { success: true, created: 1, updated: 1, deleted: 1 },
      );
      assert.deepEqual(
        gladys.fake.calendarEvents.map((e) => [e.external_id, e.calendar_external_id, e.start]),
        [
          ['ext:test-integration:john:a', primary, '2026-08-14T09:30:00.000Z'],
          ['ext:test-integration:john:c', primary, '2026-09-02T09:00:00.000Z'],
          ['ext:test-integration:john:d', primary, '2026-08-31T23:00:00.000Z'],
        ],
      );
      // An event republished under another calendar of the user is moved.
      assert.deepEqual(await gladys.publishCalendarEvents(work, [event('c', '2026-09-02T09:00:00.000Z')]), {
        success: true,
        created: 0,
        updated: 1,
        deleted: 0,
      });
      assert.equal(gladys.fake.calendarEvents.find((e) => e.name === 'c').calendar_external_id, work);
      assert.equal(gladys.fake.publishedCalendarEvents.length, 3);
      await rejectsWith400(
        gladys.publishCalendarEvents(primary, [event('x', '2026-10-01T00:00:00.000Z')], {
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-09-01T00:00:00.000Z',
        }),
        /events\[0\]: must overlap the window/,
      );
      // A sync-disabled calendar refuses the push, an unknown one or a disabled user's is not found.
      gladys.fake.calendars[0].sync = false;
      await assert.rejects(gladys.publishCalendarEvents(primary, []), (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.message, 'CALENDAR_SYNC_DISABLED');
        return true;
      });
      await assert.rejects(gladys.publishCalendarEvents(gladys.externalId('john:nope'), []), (error) => {
        assert.equal(error.status, 404);
        return true;
      });
      gladys.fake.calendarAccounts = [];
      await assert.rejects(gladys.publishCalendarEvents(work, []), (error) => {
        assert.equal(error.status, 404);
        return true;
      });
    });

    it('should feed the declared energy calendars, read them back and list the contracts', async () => {
      const contract = { id: 'c1', template_key: 'agile', pricing_mode: 'delegated', status: 'active' };
      const gladys = createFakeGladys({
        energyCalendars: { tempo: [{ starts_at: '2026-01-10T23:00:00.000Z', value: 'blue' }], 'spot-fr': [] },
        energyContracts: [contract],
      });
      assert.deepEqual(await gladys.getEnergyContracts(), [contract]);
      assert.deepEqual(
        await gladys.publishEnergyCalendar('tempo', [
          { date: '2026-01-12', value: 'red' },
          { starts_at: '2026-01-11T00:00:00.000Z', value: 'white' },
          { starts_at: '2026-01-10T23:00:00.000Z', value: 'blue' },
        ]),
        { success: true, count: 3, changed_from: '2026-01-11T00:00:00.000Z' },
      );
      assert.deepEqual(await gladys.publishEnergyCalendar('tempo', [{ date: '2026-01-12', value: 'red' }]), {
        success: true,
        count: 1,
        changed_from: null,
      });
      assert.deepEqual(await gladys.publishEnergyCalendar('tempo', [{ date: '2026-01-12', value: 'white' }]), {
        success: true,
        count: 1,
        changed_from: '2026-01-12T00:00:00.000Z',
      });
      assert.deepEqual(await gladys.getEnergyCalendar('tempo'), [
        { starts_at: '2026-01-10T23:00:00.000Z', value: 'blue' },
        { starts_at: '2026-01-11T00:00:00.000Z', value: 'white' },
        { starts_at: '2026-01-12T00:00:00.000Z', value: 'white' },
      ]);
      assert.deepEqual(await gladys.getEnergyCalendar('tempo', { limit: 1 }), [
        { starts_at: '2026-01-12T00:00:00.000Z', value: 'white' },
      ]);
      assert.deepEqual(await gladys.getEnergyCalendar('tempo', { from: '2026-01-11', limit: 1 }), [
        { starts_at: '2026-01-11T00:00:00.000Z', value: 'white' },
      ]);
      assert.deepEqual(await gladys.getEnergyCalendar('tempo', { from: '2026-01-11', to: '2026-01-11T12:00:00Z' }), [
        { starts_at: '2026-01-11T00:00:00.000Z', value: 'white' },
      ]);
      await gladys.publishEnergyCalendar('spot-fr', [
        { starts_at: '2026-01-12T05:00:00Z', price: 0.18, currency: 'EUR' },
      ]);
      assert.deepEqual(gladys.fake.energyCalendars['spot-fr'], [
        { starts_at: '2026-01-12T05:00:00.000Z', value: 0.18 },
      ]);
      assert.equal(gladys.fake.publishedEnergyCalendars.length, 4);
      const forbidden = (promise) =>
        assert.rejects(promise, (error) => {
          assert.ok(error instanceof GladysApiError);
          assert.equal(error.status, 403);
          assert.match(error.message, /not declared by this integration/);
          return true;
        });
      await forbidden(gladys.publishEnergyCalendar('holidays-fr', [{ date: '2026-01-01', value: 'holiday' }]));
      await forbidden(gladys.getEnergyCalendar('holidays-fr'));
      gladys.requestEnergyRecalculation();
      assert.equal(gladys.fake.energyRecalculations, 1);
    });

    it('should upsert the consumption published after the fact like the core and refuse what it refuses', async () => {
      const consumption = (type, suffix) => ({
        name: suffix,
        external_id: `ext:test-integration:meter:${suffix}`,
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      });
      const meter = sensor({
        name: 'Meter',
        external_id: 'ext:test-integration:meter',
        features: [
          consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION, 'consumption'),
          consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION, 'daily'),
          { ...consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX, 'index'), id: 'index-id' },
          consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION, 'index_consumption'),
          {
            ...consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION, 'derived'),
            energy_parent_id: 'index-id',
          },
          consumption(DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY, 'energy'),
        ],
      });
      const gladys = createFakeGladys({
        devices: [meter],
        energyConsumption: {
          'ext:test-integration:meter:daily': [{ created_at: '2026-01-10T00:00:00.000Z', kwh: 10 }],
        },
      });
      // Upserted by instant: a 30-minute interval is stamped at its end, the
      // last value given for an instant wins, an unchanged value writes nothing.
      assert.deepEqual(
        await gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [
          { starts_at: '2026-01-12T05:30:00Z', kwh: 0.38 },
          { starts_at: new Date('2026-01-12T05:00:00.000Z'), kwh: 0.1 },
          { starts_at: '2026-01-12T05:00:00+00:00', kwh: 0.42 },
        ]),
        { success: true, count: 2, changed_from: '2026-01-12T05:30:00.000Z' },
      );
      assert.deepEqual(gladys.fake.energyConsumption['ext:test-integration:meter:consumption'], [
        { created_at: '2026-01-12T05:30:00.000Z', kwh: 0.42 },
        { created_at: '2026-01-12T06:00:00.000Z', kwh: 0.38 },
      ]);
      assert.deepEqual(
        await gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [
          { starts_at: '2026-01-12T05:30:00Z', kwh: 0.38 },
        ]),
        { success: true, count: 1, changed_from: null },
      );
      assert.deepEqual(
        await gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [
          { starts_at: '2026-01-12T05:30:00Z', kwh: 0.4 },
          { starts_at: '2026-01-12T04:30:00Z', kwh: 0.5 },
        ]),
        { success: true, count: 2, changed_from: '2026-01-12T05:00:00.000Z' },
      );
      // A daily feature takes dates (UTC midnights here) and is stamped at the start of the day.
      assert.deepEqual(
        await gladys.publishEnergyConsumption('ext:test-integration:meter:daily', [
          { date: '2026-01-12', kwh: 18.4 },
          { starts_at: '2026-01-11T00:00:00.000Z', kwh: 17 },
          { date: '2026-01-10', kwh: 10 },
        ]),
        { success: true, count: 3, changed_from: '2026-01-11T00:00:00.000Z' },
      );
      assert.deepEqual(gladys.fake.energyConsumption['ext:test-integration:meter:daily'], [
        { created_at: '2026-01-10T00:00:00.000Z', kwh: 10 },
        { created_at: '2026-01-11T00:00:00.000Z', kwh: 17 },
        { created_at: '2026-01-12T00:00:00.000Z', kwh: 18.4 },
      ]);
      assert.equal(gladys.fake.publishedEnergyConsumption.length, 4);
      assert.deepEqual(gladys.fake.publishedEnergyConsumption[3], {
        device_feature_external_id: 'ext:test-integration:meter:daily',
        intervals: [
          { date: '2026-01-12', kwh: 18.4 },
          { starts_at: '2026-01-11T00:00:00.000Z', kwh: 17 },
          { date: '2026-01-10', kwh: 10 },
        ],
      });
      // What the core refuses.
      const interval = { starts_at: '2026-01-12T05:00:00Z', kwh: 1 };
      await assert.rejects(
        gladys.publishEnergyConsumption('ext:test-integration:meter:unknown', [interval]),
        (error) => {
          assert.ok(error instanceof GladysApiError);
          assert.equal(error.status, 404);
          assert.match(error.message, /the device is not created/);
          return true;
        },
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:energy', [interval]),
        /must be a 30-minute or daily consumption feature/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:index_consumption', [interval]),
        /derived from a cumulative index by the core/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:derived', [{ date: '2026-01-12', kwh: 1 }]),
        /derived from a cumulative index by the core/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [{ date: '2026-01-12', kwh: 1 }]),
        /intervals\[0\]\.date: a 30-minute consumption takes starts_at/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [
          { starts_at: '2026-01-12T05:10:00Z', kwh: 1 },
        ]),
        /intervals\[0\]\.starts_at: must be aligned on a 30-minute slot of UTC/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:daily', [
          { starts_at: '2026-01-12T05:00:00Z', kwh: 1 },
        ]),
        /intervals\[0\]\.starts_at: must be a local midnight of UTC/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:consumption', [
          { starts_at: new Date(Math.ceil(Date.now() / 1800000) * 1800000), kwh: 1 },
        ]),
        /intervals\[0\]: the interval must be elapsed/,
      );
      await rejectsWith400(
        gladys.publishEnergyConsumption('ext:test-integration:meter:daily', [{ date: '2015-01-12', kwh: 1 }]),
        /intervals\[0\]: starts_at must be at most 5 years ago/,
      );
      assert.equal(gladys.fake.publishedEnergyConsumption.length, 4);
      assert.equal(gladys.fake.requests.filter((request) => request.status !== 200).length, 9);
    });

    it('should simulate the image download of a sub-container seeded pulling', async () => {
      const gladys = createFakeGladys({
        containers: [
          { name: 'frigate', status: 'pulling', desired: 'stopped', started_at: null, ports: [], pull: null },
          { name: 'mqtt', status: 'pulling', desired: 'stopped', started_at: null, ports: [], pull: null },
        ],
      });
      const frigate = gladys.startContainer('frigate');
      const mqtt = gladys.restartContainer('mqtt');
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      gladys.fake.finishPull('frigate');
      gladys.fake.finishPull('mqtt', { lastError: 'UNABLE_TO_PULL_IMAGE' });
      assert.deepEqual(await frigate, { success: true, status: 'running' });
      await assert.rejects(mqtt, { code: 'UNABLE_TO_PULL_IMAGE' });
      assert.deepEqual(gladys.fake.containers[0], {
        name: 'frigate',
        status: 'running',
        desired: 'stopped',
        started_at: null,
        ports: [],
        pull: null,
        last_error: null,
      });
      assert.equal(gladys.fake.containers[1].status, 'stopped');
      // a container that is not downloading starts right away
      assert.deepEqual(await gladys.startContainer('frigate'), { success: true });
      assert.throws(() => gladys.fake.finishPull('unknown'), /no sub-container named unknown/);
    });

    it('should answer success to the other calls and record them', async () => {
      const gladys = createFakeGladys();
      assert.deepEqual(await gladys.startContainer('mqtt', { env: { PASSWORD: 'x' } }), { success: true });
      assert.deepEqual(await gladys.wakeOnLan('64:e4:d5:b4:12:66'), { success: true });
      assert.deepEqual(gladys.fake.requests, [
        { method: 'POST', path: '/container/mqtt/start', body: { env: { PASSWORD: 'x' } }, status: 200 },
        { method: 'POST', path: '/network/wake', body: { mac: '64:e4:d5:b4:12:66' }, status: 200 },
      ]);
      assert.deepEqual(gladys.fake.bodies('POST', '/network/wake'), [{ mac: '64:e4:d5:b4:12:66' }]);
    });
  });

  describe('host API validation', () => {
    it('should accept a valid device, the poll frequency in milliseconds and a null unit', async () => {
      const gladys = createFakeGladys();
      const device = sensor();
      device.features[0].unit = null;
      assert.equal((await gladys.publishDiscoveredDevices([device])).count, 1);
    });

    it('should reject a poll frequency in seconds, like Gladys', async () => {
      const gladys = createFakeGladys();
      await rejectsWith400(
        gladys.publishDiscoveredDevices([sensor({ poll_frequency: 300 })]),
        /devices\[0\]\.poll_frequency: invalid poll frequency \(milliseconds, one of DEVICE_POLL_FREQUENCIES: 60000, 30000, 15000, 10000, 2000, 1000\)/,
      );
      // Recorded as received, but not as published.
      assert.equal(gladys.fake.requests[0].status, 400);
      assert.deepEqual(gladys.fake.discoveredDevices, []);
    });

    it('should reject the discovered devices Gladys refuses', async () => {
      const gladys = createFakeGladys();
      const feature = sensor().features[0];
      const cases = [
        ['not an array', /devices: must be an array/],
        [[null], /devices\[0\]: must be an object/],
        [[sensor({ name: '' })], /devices\[0\]\.name: must be a non-empty string/],
        [[sensor({ external_id: 'sensor:1' })], /devices\[0\]\.external_id: must start with "ext:test-integration:"/],
        [[sensor({ features: undefined })], /devices\[0\]\.features: must be an array/],
        [[sensor({ features: [null] })], /devices\[0\]\.features\[0\]: must be an object/],
        [
          [sensor({ features: [{ ...feature, external_id: 'temperature' }] })],
          /features\[0\]\.external_id: must start with/,
        ],
        [
          [sensor({ features: [{ ...feature, category: 'thermometer' }] })],
          /features\[0\]\.category: unknown category/,
        ],
        [[sensor({ features: [{ ...feature, type: 'float' }] })], /features\[0\]\.type: unknown type/],
        [[sensor({ features: [{ ...feature, unit: 'parsec' }] })], /features\[0\]\.unit: unknown unit/],
      ];
      for (const [devices, message] of cases) {
        await rejectsWith400(gladys.publishDiscoveredDevices(devices), message);
      }
    });

    it('should reject the states Gladys refuses', async () => {
      const gladys = createFakeGladys();
      const id = 'ext:test-integration:sensor:1:temperature';
      const cases = [
        [[null], /states\[0\]: must be an object/],
        [[{ device_feature_external_id: 'sensor:1:temperature', state: 1 }], /must start with "ext:test-integration:"/],
        [[{ device_feature_external_id: id }], /states\[0\]: must have a numeric "state" or a string "text"/],
        // NaN reaches Gladys as null.
        [[{ device_feature_external_id: id, state: NaN }], /must have a numeric "state"/],
        [
          [{ device_feature_external_id: id, state: 1, created_at: 'yesterday' }],
          /created_at: must be an ISO 8601 date/,
        ],
        [
          [{ device_feature_external_id: id, state: 1, created_at: 1700000000000 }],
          /created_at: must be an ISO 8601 date/,
        ],
      ];
      for (const [states, message] of cases) {
        await rejectsWith400(gladys.publishStates(states), message);
      }
      assert.deepEqual(gladys.fake.states, []);
    });
  });

  describe('simulations of Gladys calling the handlers', () => {
    const device = { external_id: 'ext:test-integration:plug:1', selector: 'plug-1', params: [] };
    const feature = { external_id: 'ext:test-integration:plug:1:binary', category: 'switch', type: 'binary' };

    it('should run onSetValue and resolve with its ack', async () => {
      const gladys = createFakeGladys();
      let received;
      gladys.onSetValue(async (...args) => {
        received = args;
        await gladys.publishState(args[1].external_id, args[2]);
      });
      assert.deepEqual(await gladys.fake.setValue(device, feature, 1), { success: true });
      assert.deepEqual(received, [device, feature, 1]);
      assert.equal(gladys.fake.lastState(feature.external_id), 1);
    });

    it('should resolve with a failed ack when the handler throws or is missing', async () => {
      const gladys = createFakeGladys();
      assert.deepEqual(await gladys.fake.poll(device), { success: false, error: 'not implemented' });
      gladys.onPoll(async () => {
        throw new Error('device unreachable');
      });
      assert.deepEqual(await gladys.fake.poll(device), { success: false, error: 'device unreachable' });
    });

    it('should run onPoll, onGetImage, onWeatherGet and onWeatherGetImage', async () => {
      const gladys = createFakeGladys();
      const polled = [];
      gladys.onPoll(async (polledDevice) => {
        polled.push(polledDevice);
      });
      gladys.onGetImage(async () => 'image/jpg;base64,AAAA');
      gladys.onWeatherGet(async (options) => ({ temperature: 20, weather: 'clear', datetime: 'now', options }));
      gladys.onWeatherGetImage(async (key) => `base64-of-${key}`);
      const weatherOptions = { latitude: 48.8, longitude: 2.3, language: 'en', units: 'metric' };
      assert.deepEqual(await gladys.fake.poll(device), { success: true });
      assert.deepEqual(polled, [device]);
      assert.deepEqual(await gladys.fake.getImage(device), { success: true, data: { image: 'image/jpg;base64,AAAA' } });
      assert.deepEqual((await gladys.fake.weatherGet(weatherOptions)).data.weather.options, weatherOptions);
      assert.deepEqual(await gladys.fake.weatherGetImage('radar'), {
        success: true,
        data: { image: 'base64-of-radar' },
      });
    });

    it('should run onScanRequest and let its error reject', async () => {
      const gladys = createFakeGladys();
      gladys.onScanRequest(async () => {
        await gladys.publishDiscoveredDevices([sensor()]);
      });
      assert.equal(await gladys.fake.scanRequest(), undefined);
      assert.equal(gladys.fake.discoveredDevices.length, 1);
      gladys.onScanRequest(async () => {
        throw new Error('scan failed');
      });
      await assert.rejects(gladys.fake.scanRequest(), /scan failed/);
    });

    it('should resolve an event without handler', async () => {
      const gladys = createFakeGladys();
      assert.equal(await gladys.fake.scanRequest(), undefined);
    });

    it('should create, update and delete a device on both sides', async () => {
      const gladys = createFakeGladys();
      const events = [];
      gladys.onDeviceCreated(async (d) => events.push(['created', d.name]));
      gladys.onDeviceUpdated(async (d) => events.push(['updated', d.name]));
      gladys.onDeviceDeleted(async (d) => events.push(['deleted', d.name]));
      await gladys.connect();
      await gladys.fake.deviceCreated(sensor());
      assert.deepEqual(gladys.devices, [sensor()]);
      assert.deepEqual(gladys.fake.devices, [sensor()]);
      await gladys.fake.deviceUpdated(sensor({ name: 'Renamed' }));
      assert.deepEqual(gladys.devices, [sensor({ name: 'Renamed' })]);
      assert.deepEqual(await gladys.getDevices(), [sensor({ name: 'Renamed' })]);
      await gladys.fake.deviceDeleted(sensor());
      assert.deepEqual(gladys.devices, []);
      assert.deepEqual(gladys.fake.devices, []);
      assert.deepEqual(events, [
        ['created', 'Sensor'],
        ['updated', 'Renamed'],
        ['deleted', 'Sensor'],
      ]);
    });

    it('should re-publish the deduplicated states of a device once created', async () => {
      const gladys = createFakeGladys();
      const states = [{ device_feature_external_id: 'ext:test-integration:sensor:1:temperature', state: 21 }];
      await gladys.publishChangedStates(states);
      assert.equal((await gladys.publishChangedStates(states)).count, 0);
      await gladys.fake.deviceCreated(sensor());
      assert.equal((await gladys.publishChangedStates(states)).count, 1);
    });

    it('should update the config on both sides with onConfigUpdated', async () => {
      const gladys = createFakeGladys({ config: { api_key: 'old' } });
      let received;
      gladys.onConfigUpdated(async (config) => {
        received = config;
      });
      await gladys.connect();
      await gladys.fake.configUpdated({ api_key: 'new' });
      assert.deepEqual(received, { api_key: 'new' });
      assert.deepEqual(gladys.config, { api_key: 'new' });
      assert.deepEqual(gladys.fake.config, { api_key: 'new' });
    });

    it('should run onHardwareUpdated', async () => {
      const gladys = createFakeGladys();
      const containers = [{ name: 'frigate', devices: [{ class: 'coral', granted: true, available: true }] }];
      let received;
      gladys.onHardwareUpdated(async (value) => {
        received = value;
      });
      await gladys.fake.hardwareUpdated(containers);
      assert.deepEqual(received, containers);
    });

    it('should run the OAuth handlers', async () => {
      const gladys = createFakeGladys();
      const calls = [];
      gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => `https://provider/authorize?key=${key}&r=${redirectUri}`);
      gladys.onOAuthCallback(async (...args) => {
        calls.push(args);
      });
      assert.deepEqual(await gladys.fake.oauthAuthorizeUrl('account', 'https://gladys/cb'), {
        success: true,
        data: { authorize_url: 'https://provider/authorize?key=account&r=https://gladys/cb' },
      });
      await gladys.fake.oauthCallback('account', { code: 'abc', state: 'xyz', redirectUri: 'https://gladys/cb' });
      await gladys.fake.oauthCallback('account');
      assert.deepEqual(calls, [
        ['account', { code: 'abc', state: 'xyz', redirectUri: 'https://gladys/cb' }],
        ['account', { code: undefined, state: undefined, redirectUri: undefined }],
      ]);
    });

    it('should run onSendMessage', async () => {
      const gladys = createFakeGladys();
      let received;
      gladys.onSendMessage(async (...args) => {
        received = args;
      });
      assert.deepEqual(await gladys.fake.sendMessage({ id: '12345' }, { text: 'Hello', file: null }), {
        success: true,
      });
      assert.deepEqual(received, [{ id: '12345' }, { text: 'Hello', file: null }]);
    });

    it('should relay the webhooks in both modes', async () => {
      const gladys = createFakeGladys();
      const requests = [];
      gladys.onWebhook('events', async (request) => {
        requests.push(request);
      });
      gladys.onWebhook('callback', async ({ query }) => ({
        status: 200,
        contentType: 'text/plain',
        body: query.challenge,
      }));
      const request = { method: 'POST', query: {}, body: '{"event":"motion"}', contentType: 'application/json' };
      assert.equal(await gladys.fake.webhook('events', request), undefined);
      assert.equal(await gladys.fake.webhook('events'), undefined);
      assert.deepEqual(requests, [
        request,
        { method: undefined, query: undefined, body: undefined, contentType: undefined },
      ]);
      assert.deepEqual(
        await gladys.fake.webhook('callback', { method: 'GET', query: { challenge: '42' } }, { mode: 'sync' }),
        { success: true, data: { status: 200, content_type: 'text/plain', body: '42' } },
      );
    });

    it('should update the webhook state on both sides with onWebhookUpdated', async () => {
      const gladys = createFakeGladys();
      const webhooks = { available: true, webhooks: [{ key: 'events', mode: 'fire_and_forget', url: 'https://x' }] };
      let received;
      gladys.onWebhookUpdated(async (value) => {
        received = value;
      });
      await gladys.fake.webhookUpdated(webhooks);
      assert.deepEqual(received, webhooks);
      assert.deepEqual(await gladys.getWebhooks(), webhooks);
    });

    it('should run the manifest actions and the scene actions', async () => {
      const gladys = createFakeGladys();
      gladys.onAction('test_connection', async (fields) => `ok ${JSON.stringify(fields)}`);
      gladys.onSceneAction('snapshot', async (fields) => ({ clip_id: `clip-${Object.keys(fields).length}` }));
      assert.deepEqual(await gladys.fake.action('test_connection', { ip: '1.2.3.4' }), {
        success: true,
        data: { message: 'ok {"ip":"1.2.3.4"}' },
      });
      assert.deepEqual(await gladys.fake.action('test_connection'), { success: true, data: { message: 'ok {}' } });
      assert.deepEqual(await gladys.fake.sceneAction('snapshot', { camera: 'x' }), {
        success: true,
        data: { outputs: { clip_id: 'clip-1' } },
      });
      assert.deepEqual(await gladys.fake.sceneAction('snapshot'), {
        success: true,
        data: { outputs: { clip_id: 'clip-0' } },
      });
    });

    it('should run the widget handlers', async () => {
      const gladys = createFakeGladys();
      const calls = [];
      gladys.onWidgetGet('vacuum', async (options) => {
        calls.push(options);
        return { components: [{ type: 'text', text: { en: 'Docked' } }] };
      });
      gladys.onWidgetGetImage(async (imageKey) => `base64-of-${imageKey}`);
      gladys.onWidgetAction('vacuum', async (actionKey, params, { settings }) => ({
        en: `${actionKey} ${params.room || ''} ${settings.vacuum || ''}`.trim(),
      }));
      assert.deepEqual(await gladys.fake.widgetGet('vacuum'), {
        success: true,
        data: { content: { components: [{ type: 'text', text: { en: 'Docked' } }] } },
      });
      await gladys.fake.widgetGet('vacuum', {
        settings: { vacuum: 'ext:test-integration:robot:1' },
        language: 'fr',
        units: 'us',
      });
      assert.deepEqual(calls, [
        { settings: {}, language: 'en', units: 'metric' },
        { settings: { vacuum: 'ext:test-integration:robot:1' }, language: 'fr', units: 'us' },
      ]);
      assert.deepEqual(await gladys.fake.widgetGetImage('poster-1'), {
        success: true,
        data: { image: 'base64-of-poster-1' },
      });
      assert.deepEqual(await gladys.fake.widgetAction('vacuum', 'start'), {
        success: true,
        data: { message: { en: 'start' } },
      });
      assert.deepEqual(
        await gladys.fake.widgetAction('vacuum', 'clean', { room: 'kitchen' }, { settings: { vacuum: 'robot' } }),
        { success: true, data: { message: { en: 'clean kitchen robot' } } },
      );
      const options = [];
      gladys.onWidgetAction('pellets', async (actionKey, params, received) => {
        options.push(received);
      });
      await gladys.fake.widgetAction('pellets', 'delivery');
      await gladys.fake.widgetAction('pellets', 'delivery', {}, { values: { bags: 72 } });
      assert.deepEqual(options, [{ settings: {} }, { settings: {}, values: { bags: 72 } }]);
    });

    it('should run onCalendarAccountUpdated, onEnergyPrice and onEnergyCurrent', async () => {
      const gladys = createFakeGladys();
      const users = [];
      gladys.onCalendarAccountUpdated(async (userSelector) => {
        users.push(userSelector);
      });
      gladys.onEnergyPrice(async ({ intervals }) =>
        intervals.map((i) => ({ starts_at: i.starts_at, cost: i.kwh * 0.2 })),
      );
      gladys.onEnergyCurrent(async ({ max_power_kw: maxPowerKw }) => ({ price: 0.2, label: `peak ${maxPowerKw}` }));
      assert.equal(await gladys.fake.calendarAccountUpdated('john'), undefined);
      assert.deepEqual(users, ['john']);
      const request = {
        contract: { id: 'c1' },
        billing_period: { starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-02-01T00:00:00.000Z' },
        cumulative_before: { day: 0, month: 0, billing_period: 0 },
        intervals: [{ starts_at: '2026-01-12T05:00:00.000Z', kwh: 1, max_power_kw: 2 }],
      };
      assert.deepEqual(await gladys.fake.energyPrice(request), {
        success: true,
        data: { costs: [{ starts_at: '2026-01-12T05:00:00.000Z', cost: 0.2 }] },
      });
      assert.deepEqual(
        await gladys.fake.energyCurrent({ contract: { id: 'c1' }, cumulative: { day: 1 }, max_power_kw: 2 }),
        { success: true, data: { price: 0.2, label: 'peak 2' } },
      );
    });

    it('should send any message type through send()', async () => {
      const gladys = createFakeGladys();
      let scanned = false;
      gladys.onScanRequest(async () => {
        scanned = true;
      });
      assert.equal(await gladys.fake.send(EXTERNAL_INTEGRATION.SCAN_REQUEST), undefined);
      assert.equal(scanned, true);
      // Unknown types are ignored, like the real client does.
      assert.equal(await gladys.fake.send('external-integration.future-message', { anything: true }), undefined);
    });
  });

  describe('handleShutdown() / fake.shutdown(signal?)', () => {
    it('should run the cleanup then disconnect, without listening to the process signals', async () => {
      const gladys = createFakeGladys();
      const listeners = process.listenerCount('SIGTERM');
      const signals = [];
      gladys.handleShutdown(async (signal) => {
        signals.push(signal);
      });
      assert.equal(process.listenerCount('SIGTERM'), listeners);
      await gladys.connect();
      await gladys.fake.shutdown();
      assert.equal(gladys.connected, false);
      await gladys.fake.shutdown('SIGINT');
      assert.deepEqual(signals, ['SIGTERM', 'SIGINT']);
    });

    it('should disconnect even when the cleanup throws, then reject with its error', async () => {
      const gladys = createFakeGladys();
      gladys.handleShutdown(async () => {
        throw new Error('cleanup failed');
      });
      await gladys.connect();
      await assert.rejects(gladys.fake.shutdown(), /cleanup failed/);
      assert.equal(gladys.connected, false);
    });

    it('should only disconnect without cleanup', async () => {
      const gladys = createFakeGladys();
      gladys.handleShutdown();
      await gladys.connect();
      await gladys.fake.shutdown();
      assert.equal(gladys.connected, false);
    });
  });
});
