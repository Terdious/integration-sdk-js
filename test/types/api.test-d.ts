/**
 * Compile-time check of the public typings (`npm run check-types`).
 * Mirrors the example of contract C.8.
 */
import {
  ActionFields,
  CalendarAccount,
  CalendarEventInput,
  CalendarInput,
  CalendarWindow,
  ContainerPort,
  EnergyCalendarEntry,
  EnergyCalendarEntryInput,
  EnergyConsumptionIntervalInput,
  EnergyContract,
  EnergyCurrentPrice,
  EnergyCurrentRequest,
  EnergyIntervalCost,
  EnergyPriceRequest,
  IntegrationCalendar,
  PublishCalendarEventsResponse,
  PublishCalendarsResponse,
  PublishEnergyCalendarResponse,
  PublishEnergyConsumptionResponse,
  WidgetActionField,
  WidgetActionValues,
  ContainerPortProtocol,
  createLogger,
  Device,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_POLL_FREQUENCIES,
  DEVICE_TRANSPORTS,
  DeviceExternalIds,
  DeviceFeature,
  DeviceFeatureSupportedOption,
  DeviceTransport,
  DeviceTransportEntry,
  GladysApiError,
  GladysIntegration,
  HardwareUpdatedContainer,
  House,
  IntegrationConfig,
  IntegrationContainer,
  ContainerControlResponse,
  ContainerPullProgress,
  ContainerStartError,
  LinkedContact,
  LinkedUser,
  logger,
  MessageContact,
  Logger,
  MdnsScanResult,
  NetworkActiveScanOptions,
  OutgoingMessage,
  parseMdnsTxt,
  PublishChangedStatesResponse,
  SceneActionFields,
  SceneActionOutputs,
  SceneEventData,
  SsdpScanResult,
  UdpBroadcastScanResult,
  validateWidgetContent,
  validateWidgetImage,
  WakeOnLanOptions,
  WEATHER_ALERT_SEVERITIES,
  WEATHER_ALERT_TYPES,
  WEATHER_CONDITIONS,
  WeatherAlert,
  WeatherAlertType,
  WeatherCondition,
  WeatherDayForecast,
  WeatherGetOptions,
  WeatherHourForecast,
  WeatherImage,
  WeatherPayload,
  WebhookRequest,
  WebhooksInfo,
  WebhookSyncResponse,
  WEBSOCKET_MESSAGE_TYPES,
  WIDGET_BUTTON_STYLES,
  WIDGET_CARD_LIST_DISPLAYS,
  WIDGET_CHART_INTERVALS,
  WIDGET_CHART_TYPES,
  WIDGET_COLORS,
  WIDGET_IMAGE_FITS,
  WIDGET_TEXT_VARIANTS,
  WidgetActionResult,
  WidgetChartComponent,
  WidgetColor,
  WidgetButtonComponent,
  WidgetComponent,
  WidgetContent,
  WidgetGetOptions,
  WidgetSettings,
} from '@gladysassistant/integration-sdk';

const main = async (): Promise<void> => {
  const gladys = new GladysIntegration({
    hostApiUrl: 'http://172.30.0.1:80',
    token: 'jwt',
    selector: 'ext-demo',
  });

  gladys.onScanRequest(async () => {
    await gladys.publishDiscoveredDevices([
      {
        name: 'Virtual switch',
        external_id: gladys.externalId('switch'),
        should_poll: true,
        poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
        features: [
          {
            name: 'On/Off',
            external_id: gladys.externalId('switch:binary'),
            category: 'switch',
            type: 'binary',
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

  gladys.onSetValue(async (device: Device, feature: DeviceFeature, value: number | string) => {
    if (feature.type === DEVICE_FEATURE_TYPES.TEXT.SELECT) {
      // A select command carries the selected option's string value; its
      // state is the string form (last_value_string, no history).
      await gladys.publishState(feature.external_id, { text: String(value) });
      return;
    }
    await gladys.publishState(feature.external_id, Number(value));
  });

  gladys.onPoll(async (device: Device) => {
    await gladys.publishState(`${device.external_id}:temperature`, { state: 21.5, created_at: new Date() });
  });

  gladys.onGetImage(async (device: Device) => `image/jpg;base64,${device.external_id}`);

  gladys.onConfigUpdated(async (config: IntegrationConfig) => {
    await gladys.setConfig({ last_seen_config: JSON.stringify(config) });
  });

  gladys.onHardwareUpdated(async (containers: HardwareUpdatedContainer[]) => {
    const granted: boolean = containers[0].devices[0].granted;
    void granted;
  });

  gladys.onOAuthAuthorizeUrl(
    // redirectUri is undefined for an `account_link` field (a provider that
    // never redirects back to Gladys).
    async (key: string, redirectUri: string | undefined) =>
      `https://provider.example/authorize?key=${key}&redirect_uri=${redirectUri ?? ''}`,
  );

  gladys.onOAuthCallback(async (key: string, params: { code: string; state: string; redirectUri: string }) => {
    await gladys.setConfig({ [`${key}_code`]: params.code });
    await gladys.setConnectionStatus(true);
  });

  gladys.onAction('detect_protocol', async (fields: ActionFields) => `Detected on ${String(fields.ip)}`);
  gladys.onAction('test_connection', async () => ({ en: 'Connected!', fr: 'Connecté !' }));

  gladys.onSendMessage(async (contact: MessageContact, message: OutgoingMessage) => {
    // Linked channel (receive: true) → contact.id; send-only channel
    // (receive: false) → the target user's contact_schema values.
    const line: string = `${contact.id ?? ''} ${String(contact.username ?? '')}: ${message.text} ${message.file ?? ''}`;
    void line;
  });

  gladys.on('connected', () => {});
  gladys.on('disconnected', () => {});

  await gladys.connect();

  const devices: Device[] = await gladys.getDevices();
  const config: IntegrationConfig = await gladys.getConfig();
  const status = await gladys.getStatus();
  const version: string = status.gladys_version;

  await gladys.publishState(gladys.externalId('sensor:text'), { text: 'hello' });
  await gladys.publishStates([{ device_feature_external_id: gladys.externalId('sensor:temperature'), state: 20 }]);
  const changed: PublishChangedStatesResponse = await gladys.publishChangedStates(
    [{ device_feature_external_id: gladys.externalId('sensor:temperature'), state: 20 }],
    { heartbeat: 30 * 60 * 1000 },
  );
  const changedCount: number = changed.count;
  gladys.forgetPublishedStates(gladys.externalId('sensor'));
  gladys.forgetPublishedStates();
  const everyMinute: 60000 = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES;
  void [changedCount, everyMinute];

  await gladys.publishCameraImage(gladys.externalId('cam:abc'), 'image/jpg;base64,/9j/4AAQ');
  const transport: DeviceTransport = DEVICE_TRANSPORTS.LOCAL;
  const entries: DeviceTransportEntry[] = [{ external_id: gladys.externalId('plug:abc'), transport }];
  await gladys.publishTransports(entries);
  const degradedEntries: DeviceTransportEntry[] = [
    {
      external_id: gladys.externalId('plug:abc'),
      transport: DEVICE_TRANSPORTS.CLOUD,
      degraded: true,
      message: { en: 'Local session refused, falling back to cloud', fr: 'Session locale refusée, bascule cloud' },
    },
  ];
  await gladys.publishTransports(degradedEntries);
  const preferLocal: unknown = gladys.config.GLADYS_PREFER_LOCAL;
  void preferLocal;

  await gladys.setConnectionStatus(false, { en: 'Token expired, please reconnect.', fr: 'Token expiré.' });
  const containers: IntegrationContainer[] = await gladys.getContainers();
  const hostPort: number | null | undefined = containers[0]?.ports[0]?.host_port;
  // direct assignment: the optional chaining above would type-check even without the null
  const unassignedHostPort: ContainerPort['host_port'] = null;
  const portProtocol: ContainerPortProtocol | undefined = containers[0]?.ports[0]?.protocol;
  const browsable: boolean | undefined = containers[0]?.ports[0]?.browsable;
  const portLabel: string | undefined = containers[0]?.ports[0]?.label.en;
  // same direct assignment for the optional port name of the {{port:<name>}} placeholder
  const unnamedPort: ContainerPort['name'] = null;
  const portName: ContainerPort['name'] = 'ocpp';
  await gladys.startContainer('mqtt', { env: { MQTT_PASSWORD: 's3cr3t' } });
  // first start of a `manual` entry: the image downloads in the background (202)
  const started: ContainerControlResponse = await gladys.startContainer('mqtt');
  const startedStatus: 'pulling' | undefined = started.status;
  const pullProgress: number | null | undefined = containers[0]?.pull?.progress;
  const pullDetail: ContainerPullProgress['detail'] = null;
  const startError: ContainerStartError = 'UNABLE_TO_PULL_IMAGE';
  const lastError: IntegrationContainer['last_error'] = startError;
  await gladys.stopContainer('mqtt');
  const restarted: ContainerControlResponse = await gladys.restartContainer('frigate');
  void [startedStatus, pullProgress, pullDetail, lastError, restarted];
  const oauthType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL;
  void [hostPort, unassignedHostPort, portProtocol, browsable, portLabel, unnamedPort, portName, oauthType];

  gladys.onWebhook('events', async (request: WebhookRequest) => {
    const line: string = `${request.method} ${request.body ?? ''} ${request.contentType ?? ''}`;
    void line;
  });
  gladys.onWebhook('callback', async (request: WebhookRequest): Promise<WebhookSyncResponse> => {
    return { status: 200, contentType: 'application/json', body: JSON.stringify(request.query) };
  });
  gladys.onWebhookUpdated(async (info: WebhooksInfo) => {
    const urls: string[] = info.webhooks.map((webhook) => webhook.url);
    void urls;
  });
  const webhooksInfo: WebhooksInfo = await gladys.getWebhooks();
  const webhookAvailable: boolean = webhooksInfo.available;
  const webhookType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.WEBHOOK_REQUEST;
  void [webhookAvailable, webhookType];

  gladys.onWeatherGet(async (options: WeatherGetOptions): Promise<WeatherPayload> => {
    const units: 'metric' | 'us' = options.units;
    const hour: WeatherHourForecast = {
      temperature: 20.1,
      weather: WEATHER_CONDITIONS.DRIZZLE,
      datetime: '2026-08-01T13:00:00.000Z',
      precipitation_probability: 60,
      is_day: false,
    };
    const day: WeatherDayForecast = {
      temperature_min: 14,
      temperature_max: 24,
      datetime: new Date(),
      weather: WEATHER_CONDITIONS.PARTLY_CLOUDY,
      sunrise: new Date(),
      sunset: new Date(),
    };
    const alertType: WeatherAlertType = WEATHER_ALERT_TYPES.THUNDERSTORM;
    const alert: WeatherAlert = {
      severity: WEATHER_ALERT_SEVERITIES.SEVERE,
      event: 'Orages violents',
      type: alertType,
      description: 'Vigilance orange',
      start: new Date(),
      end: new Date(),
    };
    const condition: WeatherCondition = units === 'metric' ? WEATHER_CONDITIONS.POURING : 'hail';
    const image: WeatherImage = { key: 'vigilance-map', label: { en: 'Vigilance map', fr: 'Carte de vigilance' } };
    return {
      temperature: 21.5,
      weather: condition,
      datetime: new Date(),
      apparent_temperature: 20.9,
      humidity: 80,
      wind_speed: 4.2,
      uv_index: 3,
      sunrise: '2026-08-01T04:30:00.000Z',
      is_day: true,
      hours: [hour],
      days: [day],
      alerts: [alert],
      images: [image],
    };
  });
  gladys.onWeatherGetImage(async (key: string) => `iVBORw0KGgo${key}`);
  gladys.requestWeatherRefresh();
  const weatherType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.WEATHER_GET;
  const weatherImageType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.WEATHER_GET_IMAGE;
  const weatherRefreshType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.WEATHER_REFRESH;
  void [weatherType, weatherImageType, weatherRefreshType];

  await gladys.publishMessage('12345', 'Turn on the light');
  await gladys.publishMessage('12345', 'Received offline', { createdAt: new Date() });
  const linkedUser: LinkedUser = await gladys.linkContact('AB23CD45', '12345', 'John');
  const contacts: LinkedContact[] = await gladys.getContacts();
  const messageType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.MESSAGE_SEND;
  void [linkedUser.first_name, contacts[0]?.contact_id, messageType];

  const announcements: UdpBroadcastScanResult[] = await gladys.scanNetwork('udp-broadcast', { timeoutSeconds: 10 });
  const payload: string = announcements[0].payload_base64;
  const services: MdnsScanResult[] = await gladys.scanNetwork('mdns');
  const txt: string[] = services[0].txt;
  const parsedTxt: Record<string, string | true> = parseMdnsTxt(txt);
  const accessoryId: string | true | undefined = parsedTxt.id;
  void accessoryId;
  const responders: SsdpScanResult[] = await gladys.scanNetwork('ssdp', { timeoutSeconds: 5 });
  const headers: string = responders[0].headers;
  const mac: string | undefined = responders[0].source_mac;
  const replies: UdpBroadcastScanResult[] = await gladys.scanNetwork('udp-active-broadcast', {
    port: 9999,
    payload: Buffer.from('kasa-discovery-request'),
    timeoutSeconds: 5,
  });
  const activeScanOptions: NetworkActiveScanOptions = { port: 20002, payload: 'AAAB' };
  void [payload, txt, headers, mac, replies[0].source_ip, activeScanOptions];

  await gladys.wakeOnLan('64:e4:d5:b4:12:66');
  const wakeOptions: WakeOnLanOptions = { address: '192.168.1.255', port: 9, sourcePort: 0 };
  await gladys.wakeOnLan('64E4D5B41266', wakeOptions);

  // Houses (location: true in the manifest): coordinates may be null.
  const houses: House[] = await gladys.getHouses();
  const latitude: number | null = houses[0].latitude;
  void latitude;

  // Scene triggers and actions declared by the manifest.
  const eventData: SceneEventData = {
    camera: gladys.externalId('cam:front'),
    label: 'person',
    score: 0.92,
    zone: null,
  };
  await gladys.publishSceneEvent('object_detected', eventData);
  await gladys.publishSceneEvent('doorbell_pressed');
  gladys.onSceneAction('create_snapshot', async (fields: SceneActionFields): Promise<SceneActionOutputs> => {
    return { clip_id: `clip-${String(fields.camera)}`, count: 1 };
  });
  gladys.onSceneAction('clean', async () => {});
  const sceneActionType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.SCENE_ACTION_RUN;
  void sceneActionType;

  // Dashboard widgets declared by the manifest.
  gladys.onWidgetGet('vacuum', async (options: WidgetGetOptions): Promise<WidgetContent> => {
    const settings: WidgetSettings = options.settings;
    const units: 'metric' | 'us' = options.units;
    const color: WidgetColor = WIDGET_COLORS.SUCCESS;
    const chart: WidgetChartComponent = {
      type: 'chart',
      chart_type: WIDGET_CHART_TYPES.AREA,
      device_features: [gladys.externalId('solar:power')],
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      annotations: [{ t: '2026-09-21T12:00:00Z', value: 2.1, label: 'Peak', color: WIDGET_COLORS.WARNING }],
      now_marker: true,
    };
    const components: WidgetComponent[] = [
      { type: 'text', variant: WIDGET_TEXT_VARIANTS.HEADING, text: { en: 'Vacuum', fr: 'Aspirateur' } },
      { type: 'value', value: 82, unit: '%', label: { en: 'Battery' }, icon: 'battery', color },
      { type: 'value', device_feature: gladys.externalId(`${String(settings.vacuum)}:battery`) },
      { type: 'gauge', value: 42, min: 0, max: 100, label: 'Level' },
      { type: 'status', items: [{ label: { en: 'State' }, value: { en: 'Docked' }, color }] },
      chart,
      {
        type: 'card-list',
        display: WIDGET_CARD_LIST_DISPLAYS.GRID,
        items: [{ title: 'Movie', date: '2026-10-07', image: 'poster-1', links: [{ url: 'https://tmdb.org' }] }],
      },
      { type: 'image', key: 'cleaning-map-3f9a2c', fit: WIDGET_IMAGE_FITS.CONTAIN },
      { type: 'button', label: 'Start', style: WIDGET_BUTTON_STYLES.PRIMARY, action: { key: 'start', confirm: true } },
      { type: 'button', label: 'Dock', device_feature: gladys.externalId('vacuum:dock'), value: 1 },
      { type: 'button', label: 'Help', link: { url: 'https://docs.example' } },
    ];
    void units;
    return { version: 1, ttl_seconds: 30, components };
  });
  gladys.onWidgetGetImage(async (imageKey: string) => Buffer.from(imageKey).toString('base64'));
  gladys.onWidgetAction('vacuum', async (actionKey: string, params: Record<string, unknown>, options) => {
    const settings: WidgetSettings = options.settings;
    const result: WidgetActionResult = { en: `${actionKey} ${String(params.mode)} ${String(settings.vacuum)}` };
    return result;
  });
  gladys.onWidgetAction('solar', async () => 'Refreshed');
  gladys.onWidgetAction('silent', async () => {});
  gladys.requestWidgetRefresh('vacuum');

  // A button opening a form (action fields): the typed values reach the handler.
  const bagsField: WidgetActionField = {
    key: 'bags',
    type: 'number',
    required: true,
    min: 1,
    max: 200,
    default: 72,
    label: { en: 'Bags delivered', fr: 'Sacs livrés' },
  };
  const qualityField: WidgetActionField = {
    key: 'quality',
    type: 'select',
    label: { en: 'Quality' },
    display: 'radio',
    options: [{ value: 'a1', label: { en: 'A1' } }],
    default: 'a1',
  };
  const deliveryButton: WidgetButtonComponent = {
    type: 'button',
    label: { en: 'Pallet delivered' },
    action: { key: 'delivery', fields: [bagsField, qualityField] },
  };
  gladys.onWidgetAction('pellets', async (actionKey: string, params, options) => {
    const values: WidgetActionValues | undefined = options.values;
    return values === undefined ? undefined : { en: `${actionKey}: ${String(values.bags)} bags` };
  });
  void deliveryButton;

  // Calendar integrations (manifest type "calendar").
  const accounts: CalendarAccount[] = await gladys.getCalendarAccounts();
  const accountLanguage: string = accounts[0].user.language;
  const calendars: IntegrationCalendar[] = await gladys.getCalendars();
  const johnCalendars: IntegrationCalendar[] = await gladys.getCalendars('john');
  const skip: boolean = johnCalendars[0].sync === false;
  const calendarInput: CalendarInput = {
    external_id: gladys.externalId('john:primary'),
    name: 'Personal',
    description: null,
    color: '#3174ad',
  };
  const published: PublishCalendarsResponse = await gladys.publishCalendars('john', [calendarInput]);
  const createdCalendars: number = published.created;
  await gladys.deleteCalendar(gladys.externalId('john:old'));
  const timedEvent: CalendarEventInput = {
    external_id: gladys.externalId('john:8f3a@google.com'),
    name: 'Dentist',
    start: new Date('2026-08-14T09:00:00.000Z'),
    end: '2026-08-14T09:30:00.000Z',
    location: '12 rue des Lilas',
    url: 'https://calendar.google.com/event?eid=abc',
  };
  const fullDayEvent: CalendarEventInput = {
    external_id: gladys.externalId('john:holiday-20260815'),
    name: 'Assomption',
    start: '2026-08-15',
    end: '2026-08-16',
    full_day: true,
    description: null,
  };
  const window: CalendarWindow = { from: '2026-08-01T00:00:00.000Z', to: new Date('2026-09-01T00:00:00.000Z') };
  const events: PublishCalendarEventsResponse = await gladys.publishCalendarEvents(
    calendarInput.external_id,
    [timedEvent, fullDayEvent],
    window,
  );
  const pruned: number = events.deleted;
  await gladys.publishCalendarEvents(calendarInput.external_id, []);
  gladys.onCalendarAccountUpdated(async (userSelector: string) => {
    await gladys.getCalendars(userSelector);
  });
  const calendarType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.CALENDAR_ACCOUNT_UPDATED;
  void [accountLanguage, calendars, skip, createdCalendars, pruned, calendarType];

  // Energy contracts capability (manifest energy_contracts).
  const dayEntry: EnergyCalendarEntryInput = { date: '2026-01-12', value: 'critical-peak' };
  const priceEntry: EnergyCalendarEntryInput = { starts_at: new Date(), price: 0.1823, currency: 'GBP' };
  const energyPublished: PublishEnergyCalendarResponse = await gladys.publishEnergyCalendar('spot-gb-a', [
    dayEntry,
    priceEntry,
  ]);
  const changedFrom: string | null = energyPublished.changed_from;
  const calendarEntries: EnergyCalendarEntry[] = await gladys.getEnergyCalendar('spot-gb-a', {
    from: '2026-01-01',
    to: new Date(),
    limit: 48,
  });
  const entryValue: string | number = calendarEntries[0].value;
  const contracts: EnergyContract[] = await gladys.getEnergyContracts();
  const delegated: boolean = contracts[0].pricing_mode === 'delegated';
  gladys.onEnergyPrice(async (request: EnergyPriceRequest): Promise<EnergyIntervalCost[]> => {
    const region: unknown = request.contract.inputs.region;
    const before: number = request.cumulative_before.billing_period;
    void [region, before];
    return request.intervals.map(({ starts_at, kwh }) => ({
      starts_at,
      cost: kwh * 0.18,
      components: { energy: kwh * 0.18 },
    }));
  });
  gladys.onEnergyCurrent(async (request: EnergyCurrentRequest): Promise<EnergyCurrentPrice> => {
    const peak: number = request.max_power_kw;
    void peak;
    return { price: 0.18, valid_until: new Date(), next_price: null, label: 'Off-peak' };
  });
  gladys.requestEnergyRecalculation();
  const halfHour: EnergyConsumptionIntervalInput = { starts_at: new Date(), kwh: 0.42 };
  const day: EnergyConsumptionIntervalInput = { date: '2026-01-12', kwh: 18.4 };
  const consumptionPublished: PublishEnergyConsumptionResponse = await gladys.publishEnergyConsumption(
    'ext:demo:meter:consumption',
    [halfHour, day],
  );
  const consumptionChangedFrom: string | null = consumptionPublished.changed_from;
  const consumptionCount: number = consumptionPublished.count;
  void [consumptionChangedFrom, consumptionCount];
  const energyPriceType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.ENERGY_CONTRACT_PRICE;
  void [changedFrom, entryValue, delegated, energyPriceType];
  const contentIssues: string[] = validateWidgetContent({ components: [] });
  const imageIssues: string[] = validateWidgetImage('iVBORw0KGgo=');
  const widgetType: string = WEBSOCKET_MESSAGE_TYPES.EXTERNAL_INTEGRATION.WIDGET_GET;
  void [contentIssues, imageIssues, widgetType];

  // PTZ camera (CAMERA.MOVE/PRESET) and dynamic select (TEXT.SELECT):
  // enum-like features narrowed per device through supported_options.
  const moveOptions: DeviceFeatureSupportedOption[] = [
    { value: 1, label: 'Pan left', sort_order: 0 },
    { value: 2, label: 'Pan right', sort_order: 1 },
  ];
  const ptzFeature: DeviceFeature = {
    name: 'Move',
    external_id: gladys.externalId('cam:abc:move'),
    category: DEVICE_FEATURE_CATEGORIES.CAMERA,
    type: DEVICE_FEATURE_TYPES.CAMERA.MOVE,
    min: 0,
    max: 6,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    supported_options: moveOptions,
  };
  // String option values are only valid on the text/select pair: a dynamic
  // select is a `text` category feature, whatever device carries it (here the
  // HDMI sources of a TV device).
  const sourceFeature: DeviceFeature = {
    name: 'Source',
    external_id: gladys.externalId('tv:abc:source'),
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    read_only: false,
    supported_options: [{ value: 'hdmi1', label: 'HDMI 1' }],
  };
  const steppedFeature: DeviceFeature = {
    name: 'Target temperature',
    external_id: gladys.externalId('ac:abc:target-temperature'),
    category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
    type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE,
    min: 16,
    max: 30,
    step: 0.5,
  };
  void [ptzFeature, sourceFeature, steppedFeature];

  const error = new GladysApiError(401, 'UNAUTHORIZED', 'Invalid token');
  const parts: [number, string, string] = [error.status, error.code, error.message];

  const authType: string = WEBSOCKET_MESSAGE_TYPES.AUTHENTICATE.INTEGRATION_REQUEST;

  logger.info('connected', status.gladys_version);
  const namedLogger: Logger = createLogger({ name: 'weather-station', level: 'debug' });
  namedLogger.child('poll').debug('polling');

  const ids: DeviceExternalIds = gladys.externalIds('plug', '0x00158d0001a2b3c4');
  const featureId: string = ids.feature('power');

  const category: 'temperature-sensor' = DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR;
  const featureType: 'binary' = DEVICE_FEATURE_TYPES.SWITCH.BINARY;
  const unit: 'celsius' = DEVICE_FEATURE_UNITS.CELSIUS;

  gladys.handleShutdown(async (signal: 'SIGTERM' | 'SIGINT') => {
    logger.info('stopping on', signal);
  });
  void [ids.device, featureId, category, featureType, unit];

  await gladys.disconnect();

  // Reference otherwise-unused values so noUnusedLocals-style checks stay quiet.
  void [devices, config, version, parts, authType];
};

void main;
