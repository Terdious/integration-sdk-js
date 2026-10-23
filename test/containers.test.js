const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { FakeGladysServer } = require('./helpers/fake-gladys-server');
const { createClient } = require('./helpers/create-client');

describe('connection status & sub-container methods', () => {
  let server;
  let gladys;

  beforeEach(async () => {
    server = new FakeGladysServer();
    await server.start();
    gladys = createClient(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('gladys.setConnectionStatus(connected, message?)', () => {
    it('should POST /connection_status with the multi-language message', async () => {
      const message = { en: 'Token expired, please reconnect.', fr: 'Token expiré, reconnectez-vous.' };
      const response = await gladys.setConnectionStatus(false, message);
      assert.deepEqual(response, { success: true });
      const requests = server.getRequests('POST', '/connection_status');
      assert.deepEqual(requests[0].body, { connected: false, message });
      assert.equal(requests[0].authorization, `Bearer ${server.token}`);
    });

    it('should POST /connection_status without a message field when omitted', async () => {
      await gladys.setConnectionStatus(true);
      assert.deepEqual(server.getRequests('POST', '/connection_status')[0].body, { connected: true });
    });
  });

  describe('gladys.getContainers()', () => {
    it('should GET /container and return the declared sub-containers', async () => {
      server.containers = [
        { name: 'mqtt', status: 'running', desired: 'running', started_at: '2026-07-13T08:00:00.000Z', ports: [] },
        {
          name: 'frigate',
          status: 'stopped',
          desired: 'stopped',
          started_at: null,
          ports: [
            {
              container_port: 5000,
              protocol: 'tcp',
              host_port: 42115,
              label: { en: 'Frigate UI', fr: 'Interface Frigate' },
              name: 'frigate_ui',
              browsable: true,
            },
          ],
          devices: [{ class: 'coral-usb', granted: true, available: true }],
        },
      ];
      const containers = await gladys.getContainers();
      assert.deepEqual(containers, server.containers);
    });

    it('should keep the browsable flag and the not-yet-assigned host port of a port', async () => {
      // OCPP-like case: a WebSocket endpoint for devices, no web UI to open
      server.containers = [
        {
          name: 'ocpp',
          status: 'stopped',
          desired: 'stopped',
          started_at: null,
          ports: [
            {
              container_port: 9000,
              protocol: 'tcp',
              host_port: null,
              label: { en: 'OCPP WebSocket' },
              name: 'ocpp',
              browsable: false,
            },
          ],
          devices: [],
        },
      ];
      const [container] = await gladys.getContainers();
      assert.equal(container.ports[0].browsable, false);
      assert.equal(container.ports[0].host_port, null);
      assert.equal(container.ports[0].protocol, 'tcp');
      assert.deepEqual(container.ports[0].label, { en: 'OCPP WebSocket' });
    });

    it('should expose the manifest port name, null when the manifest declares none', async () => {
      // the name is what the {{port:<name>}} placeholder of the section texts
      // resolves against — a port declared without one comes back as null
      server.containers = [
        {
          name: 'ocpp',
          status: 'running',
          desired: 'running',
          started_at: '2026-08-07T08:00:00.000Z',
          ports: [
            {
              container_port: 9000,
              protocol: 'tcp',
              host_port: 42115,
              label: { en: 'OCPP WebSocket' },
              name: 'ocpp',
              browsable: false,
            },
            {
              container_port: 9001,
              protocol: 'tcp',
              host_port: 42116,
              label: { en: 'Debug UI' },
              name: null,
              browsable: true,
            },
          ],
          devices: [],
        },
      ];
      const [container] = await gladys.getContainers();
      assert.equal(container.ports[0].name, 'ocpp');
      assert.equal(container.ports[0].host_port, 42115);
      assert.equal(container.ports[1].name, null);
    });
  });

  describe('gladys.startContainer(name, options?)', () => {
    it('should POST /container/:name/start with an empty body by default', async () => {
      const response = await gladys.startContainer('mqtt');
      assert.deepEqual(response, { success: true });
      assert.deepEqual(server.getRequests('POST', '/container/mqtt/start')[0].body, {});
    });

    it('should POST /container/:name/start with the runtime env', async () => {
      await gladys.startContainer('mqtt', { env: { MQTT_PASSWORD: 's3cr3t' } });
      assert.deepEqual(server.getRequests('POST', '/container/mqtt/start')[0].body, {
        env: { MQTT_PASSWORD: 's3cr3t' },
      });
    });
  });

  describe('gladys.startContainer(name, options?) on a missing image (202 pulling)', () => {
    const pullingEntry = (overrides = {}) => ({
      name: 'frigate',
      status: 'pulling',
      desired: 'stopped',
      started_at: null,
      ports: [],
      pull: { progress: 10, detail: '1/4 layers' },
      last_error: null,
      ...overrides,
    });

    beforeEach(() => {
      server.forceResponse('POST', '/container/frigate/start', 202, { success: true, status: 'pulling' });
      server.forceResponse('POST', '/container/frigate/restart', 202, { success: true, status: 'pulling' });
      gladys.containerPullPollInterval = 5;
    });

    it('should poll GET /container until the container runs, relaying the progress', async () => {
      server.containers = [pullingEntry()];
      const progress = [];
      const response = await gladys.startContainer('frigate', {
        onProgress: (pull) => {
          progress.push(pull);
          if (progress.length === 1) {
            server.containers = [pullingEntry({ pull: null })];
          } else {
            server.containers = [pullingEntry({ status: 'running', desired: 'running', pull: null })];
          }
        },
      });
      assert.deepEqual(response, { success: true, status: 'running' });
      assert.deepEqual(progress, [
        { progress: 10, detail: '1/4 layers' },
        // an entry without its pull object yet reads as an unknown progress
        { progress: null, detail: null },
      ]);
      assert.equal(server.getRequests('GET', '/container').length, 3);
    });

    it('should wait the same way on a restart', async () => {
      server.containers = [pullingEntry({ status: 'running' })];
      assert.deepEqual(await gladys.restartContainer('frigate'), { success: true, status: 'running' });
    });

    it('should poll every 2 seconds by default', () => {
      assert.equal(createClient(server).containerPullPollInterval, 2000);
    });

    it('should reject with the last_error of a failed download', async () => {
      server.containers = [pullingEntry({ status: 'stopped', pull: null, last_error: 'UNABLE_TO_PULL_IMAGE' })];
      await assert.rejects(gladys.startContainer('frigate'), (error) => {
        assert.equal(error.code, 'UNABLE_TO_PULL_IMAGE');
        assert.equal(error.container, 'frigate');
        assert.match(error.message, /frigate could not start \(UNABLE_TO_PULL_IMAGE\)/);
        return true;
      });
    });

    it('should reject when the download ended without a running container', async () => {
      // stopped meanwhile (the stop aborts the download), or Gladys restarted
      server.containers = [pullingEntry({ status: 'stopped', pull: null })];
      await assert.rejects(gladys.startContainer('frigate'), { code: 'CONTAINER_NOT_STARTED' });
      // the entry vanished (update to a manifest without it)
      server.containers = [];
      await assert.rejects(gladys.restartContainer('frigate'), { code: 'CONTAINER_NOT_STARTED' });
    });

    it('should reject once the timeout is over, the download still running', async () => {
      server.containers = [pullingEntry()];
      await assert.rejects(gladys.startContainer('frigate', { timeoutMs: 20 }), (error) => {
        assert.equal(error.code, 'CONTAINER_START_TIMEOUT');
        assert.match(error.message, /still downloading its image after 0 s/);
        return true;
      });
    });

    it('should keep waiting when the onProgress callback throws', async () => {
      const warnings = [];
      gladys.logger = { ...gladys.logger, warn: (message) => warnings.push(message) };
      server.containers = [pullingEntry()];
      const response = await gladys.startContainer('frigate', {
        onProgress: () => {
          server.containers = [pullingEntry({ status: 'running' })];
          throw new Error('boom');
        },
      });
      assert.deepEqual(response, { success: true, status: 'running' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /onProgress callback threw: boom/);
    });

    it('should propagate a failure of GET /container while waiting', async () => {
      server.forceResponse('GET', '/container', 500, { status: 500, code: 'SERVER_ERROR', message: 'boom' });
      await assert.rejects(gladys.startContainer('frigate'), { code: 'SERVER_ERROR' });
    });
  });

  describe('gladys.stopContainer(name)', () => {
    it('should POST /container/:name/stop', async () => {
      const response = await gladys.stopContainer('mqtt');
      assert.deepEqual(response, { success: true });
      assert.deepEqual(server.getRequests('POST', '/container/mqtt/stop')[0].body, {});
    });
  });

  describe('gladys.restartContainer(name)', () => {
    it('should POST /container/:name/restart', async () => {
      const response = await gladys.restartContainer('frigate');
      assert.deepEqual(response, { success: true });
      assert.deepEqual(server.getRequests('POST', '/container/frigate/restart')[0].body, {});
    });
  });
});
