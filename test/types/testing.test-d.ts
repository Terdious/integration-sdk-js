/**
 * Compile-time check of the testing typings (`npm run check-types`).
 */
import { DEVICE_POLL_FREQUENCIES, DeviceState, GladysIntegration } from '@gladysassistant/integration-sdk';
import {
  createFakeGladys,
  FakeGladysAck,
  FakeGladysIntegration,
  FakeGladysRequest,
} from '@gladysassistant/integration-sdk/testing';

// The code under test only knows the real client.
const registerHandlers = (gladys: GladysIntegration): void => {
  gladys.onPoll(async (device) => {
    await gladys.publishState(`${device.external_id}:temperature`, 21.5);
  });
};

const main = async (): Promise<void> => {
  const gladys: FakeGladysIntegration = createFakeGladys({
    selector: 'weather',
    config: { api_key: 'key' },
    devices: [
      {
        external_id: 'ext:weather:station:1',
        should_poll: true,
        poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
      },
    ],
    houses: [{ id: 'house-1', name: 'Home', selector: 'home', latitude: null, longitude: null }],
    scanResults: { mdns: [] },
    calendarAccounts: [{ user: { selector: 'john', first_name: 'John', language: 'en' }, config: {} }],
    calendars: [],
    calendarEvents: [
      { calendar_external_id: 'ext:weather:john:c', external_id: 'ext:weather:john:e', name: 'E', start: '2026-08-14' },
    ],
    energyCalendars: { tempo: [{ starts_at: '2026-01-12T05:00:00.000Z', value: 'red' }] },
    energyContracts: [],
    energyConsumption: { 'ext:weather:meter:daily': [{ created_at: '2026-01-12T00:00:00.000Z', kwh: 18.4 }] },
  });
  registerHandlers(gladys);
  await gladys.connect();

  const ack: FakeGladysAck = await gladys.fake.poll({ external_id: 'ext:weather:station:1' });
  const success: boolean = ack.success;
  const error: string | undefined = ack.error;
  const last: number | string | undefined = gladys.fake.lastState('ext:weather:station:1:temperature');
  const states: DeviceState[] = gladys.fake.states;
  const requests: FakeGladysRequest[] = gladys.fake.requests;
  const status: number = requests[0].status;
  const widgetAck: FakeGladysAck = await gladys.fake.widgetGet('forecast', { language: 'fr', units: 'us' });
  const webhookAck: FakeGladysAck | undefined = await gladys.fake.webhook('events', { body: '{}' }, { mode: 'sync' });
  await gladys.fake.deviceCreated({ external_id: 'ext:weather:station:2' });
  await gladys.fake.configUpdated({ api_key: 'new' });
  await gladys.fake.scanRequest();
  gladys.fake.houses = [];
  gladys.fake.containers = [{ name: 'frigate', status: 'pulling', desired: 'stopped', started_at: null, ports: [] }];
  const frigateStart = gladys.startContainer('frigate');
  gladys.fake.finishPull('frigate');
  gladys.fake.finishPull('frigate', { lastError: 'UNABLE_TO_PULL_IMAGE' });
  await frigateStart.catch(() => undefined);
  const refreshes: string[] = gladys.fake.widgetRefreshes;
  await gladys.fake.widgetAction('pellets', 'delivery', {}, { values: { bags: 72 } });
  await gladys.fake.calendarAccountUpdated('john');
  const priceAck: FakeGladysAck = await gladys.fake.energyPrice({
    contract: {
      id: 'c',
      template_key: 't',
      inputs: {},
      currency: 'EUR',
      timezone: 'Europe/Paris',
      billing_period_start_day: 1,
    },
    billing_period: { starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-02-01T00:00:00.000Z' },
    cumulative_before: { day: 0, month: 0, billing_period: 0 },
    intervals: [{ starts_at: '2026-01-12T05:00:00.000Z', kwh: 1, max_power_kw: 2 }],
  });
  const deleted: string[] = gladys.fake.deletedCalendars;
  const recalculations: number = gladys.fake.energyRecalculations;
  const consumptionBatches: { device_feature_external_id: string }[] = gladys.fake.publishedEnergyConsumption;
  const storedKwh: number = gladys.fake.energyConsumption['ext:weather:meter:daily'][0].kwh;
  void [consumptionBatches, storedKwh];
  gladys.fake.calendars[0].sync = false;
  const query: Record<string, string> | undefined = requests[0].query;
  void [priceAck, deleted, recalculations, query];
  await gladys.fake.shutdown('SIGINT');

  void [success, error, last, states, status, widgetAck, webhookAck, refreshes];
};

void main;
