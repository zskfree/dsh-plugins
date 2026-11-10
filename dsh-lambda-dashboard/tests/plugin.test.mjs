import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { apply } from '../lib/index.js';

function client(react = {}, desktop, storage) {
  let plugin;
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    AbortController, URL, setTimeout, clearTimeout, dshDesktop: desktop, localStorage: storage,
    window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => react); } } },
  });
  return plugin;
}

function register(plugin) {
  const rows = [], disposers = [];
  plugin.apply({
    effect(callback) { disposers.push(callback()); },
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) { rows.push({ options, component }); return () => rows.splice(rows.findIndex((row) => row.options === options), 1); },
    },
  });
  return { rows, dispose() { disposers.forEach((dispose) => dispose()); } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('host is inert; client registers Lambda额度管理 and matching page, with disposal', () => {
  apply(new Proxy({}, { get() { throw Error('no host capabilities needed'); } }));
  const fixture = register(client());
  assert.equal(fixture.rows[0].options.key, fixture.rows[1].options.id);
  assert.equal(fixture.rows[1].options.label(), 'Lambda额度管理');
  fixture.dispose();
  assert.equal(fixture.rows.length, 0);
});

test('sidebar icon reserves the official icon width and centers Lambda glyph', () => {
  const iconPlugin = client({ createElement: (...args) => args });
  const fixture = register(iconPlugin);
  const icon = fixture.rows[1].component();
  assert.equal(icon[0], 'span');
  assert.equal(icon[1]['aria-hidden'], true);
  assert.deepEqual({ ...icon[1].style }, {
    display: 'inline-flex',
    width: 16,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    lineHeight: 1,
    fontSize: 18,
  });
  assert.equal(icon[2], 'λ');
  fixture.dispose();
});


test('native guest uses approved lease; unload removes it and releases exactly once', async () => {
  const guest = Object.assign(new EventTarget(), { style: {}, attributes: {}, loaded: [] });
  guest.setAttribute = (name, value) => { guest.attributes[name] = value; };
  guest.loadURL = (url) => { guest.loaded.push(url); return Promise.resolve(); };
  guest.remove = () => { guest.removed = true; };
  const released = [];
  const bridge = {
    async acquire() { return { lease: 'lease-test', partition: 'isolated-test' }; },
    async release(lease) { released.push(lease); },
    onOpenRequested(lease, callback) { this.open = callback; return () => {}; },
  };
  const container = { ownerDocument: { createElement() { return guest; } }, append() {} };
  let failures = 0;
  const dispose = client().mountDesktopPage(container, bridge, 'https://omp-api.280468.xyz/', () => { failures++; });
  await settle();
  assert.equal(guest.attributes.partition, 'isolated-test');
  assert.equal(guest.attributes.src, 'about:blank#lease-test');
  guest.dispatchEvent(new Event('dom-ready'));
  assert.deepEqual(guest.loaded, ['https://omp-api.280468.xyz/']);
  bridge.open('https://untrusted.invalid/');
  assert.equal(guest.loaded.length, 1);
  guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: false, errorCode: -105 }));
  guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -3 }));
  assert.equal(failures, 0);
  guest.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -105 }));
  assert.equal(failures, 1);
  dispose(); dispose();
  await settle();
  assert.deepEqual(released, ['lease-test']);
  assert.equal(guest.removed, true);
});

test('closing during reservation releases the late lease without mounting a guest', async () => {
  let reserve;
  const released = [];
  const bridge = { acquire: () => new Promise((resolve) => { reserve = resolve; }), release: (lease) => released.push(lease) };
  const dispose = client().mountDesktopPage(null, bridge, 'https://omp-api.280468.xyz/', assert.fail);
  await settle();
  dispose(); reserve({ lease: 'late' });
  await settle();
  assert.deepEqual(released, ['late']);
});

test('dashboard uses only HTTP and retains a safe browser fallback', () => {
  const react = {
    createElement(type, props, ...children) { return { type, props, children }; },
    useState(initial) { return [initial, () => {}]; },
    useRef() { return { current: null }; },
    useEffect() {},
  };
  const fixture = register(client(react));
  const dashboard = fixture.rows[0].component();
  assert.equal(dashboard.children[0].children.find((child) => child?.type === 'a').props.href, 'http://47.115.165.231:30179/');
  assert.equal(dashboard.children[0].children.filter((child) => child?.type === 'button').length, 0);
  fixture.dispose();
});

async function executeLogin({ origin = 'http://dashboard.test', login = true, status = 200, networkError = false } = {}) {
  const password = 'synthetic-"\\\n-password';
  let request;
  const result = await vm.runInNewContext(client().loginScript(password, 'http://dashboard.test/'), {
    location: { origin },
    document: { getElementById: () => login ? {} : null },
    AbortSignal,
    fetch: async (url, options) => {
      request = { url, options };
      if (networkError) throw Error('fixture network failure');
      return { ok: status === 200, status };
    },
  });
  return { result, request, password };
}

test('automatic login is restricted to the dashboard origin and only runs on login page', async () => {
  const wrong = await executeLogin({ origin: 'http://other.test' });
  assert.equal(wrong.result, 'wrong-origin');
  assert.equal(wrong.request, undefined);
  const ready = await executeLogin({ login: false });
  assert.equal(ready.result, 'ready');
  assert.equal(ready.request, undefined);
  const signed = await executeLogin();
  assert.equal(signed.result, 'signed-in');
  assert.equal(signed.request.url, '/api/session');
  assert.equal(signed.request.options.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(JSON.parse(signed.request.options.body).password, signed.password);
});

test('invalid password and network errors terminate login without retry loops', async () => {
  assert.equal((await executeLogin({ status: 401 })).result, 'invalid-password');
  assert.equal((await executeLogin({ status: 403 })).result, 'login-failed');
  assert.equal((await executeLogin({ networkError: true })).result, 'login-failed');
});

test('native guest logs in after navigation and reloads once, then releases on close', async () => {
  const guest = Object.assign(new EventTarget(), { style: {} });
  guest.setAttribute = () => {};
  guest.loadURL = async () => {};
  guest.remove = () => {};
  let executions = 0, reloads = 0;
  guest.executeJavaScript = async () => { executions++; return 'signed-in'; };
  guest.reload = () => { reloads++; };
  const bridge = {
    acquire: async () => ({ lease: 'login-fixture', partition: 'test' }),
    release: async () => {},
    onOpenRequested: () => () => {},
  };
  const statuses = [];
  const dispose = client().mountDesktopPage({ ownerDocument: { createElement: () => guest }, append() {} }, bridge, 'http://dashboard.test/', assert.fail, {
    readPassword: () => 'synthetic-test-password', onAuth: (status) => statuses.push(status),
  });
  await settle();
  guest.dispatchEvent(new Event('dom-ready'));
  assert.equal(executions, 0);
  guest.dispatchEvent(new Event('dom-ready'));
  await settle();
  assert.equal(executions, 1);
  assert.equal(reloads, 1);
  assert.deepEqual(statuses, ['signed-in']);
  dispose();
  guest.dispatchEvent(new Event('dom-ready'));
  await settle();
  assert.equal(executions, 1);
});

test('desktop password setup saves only to local storage and clears the input', () => {
  const refs = [];
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const react = {
    createElement(type, props, ...children) { return { type, props, children }; },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef() { const ref = { current: null }; refs.push(ref); return ref; },
    useEffect() {},
  };
  const fixture = register(client(react, { browser: {} }, storage));
  const dashboard = fixture.rows[0].component();
  refs[1].current = { value: 'synthetic-test-password' };
  dashboard.children.find((child) => child?.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(stored.get('dsh-lambda-dashboard.password.v1'), 'synthetic-test-password');
  assert.equal(refs[1].current.value, '');
  fixture.dispose();
});
