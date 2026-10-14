'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const config = {url: 'https://experiment.supabase.co', publishableKey: 'sb_publishable_test'};
const success = () => ({ok: true, status: 204});
const failure = () => ({ok: false, status: 503, json: async () => ({message: 'Temporarily unavailable'})});
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, event = {}) {
    event.preventDefault ??= () => {};
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class Element extends Events {
  constructor() {
    super();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); }
    };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  append(child) { this.children.push(child); child.parentElement = this; }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.append(child)); }
  closest(selector) { return selector === '.target' && this.classList.contains('target') ? this : null; }
  getBoundingClientRect() { return {width: 500, height: 500}; }
  focus() {}
  select() {}
  click() {}
}

// Run the browser entry points together so regressions in the block transitions,
// upload callbacks, and completion UI cannot hide behind store-only unit tests.
function browser(respond = async () => success()) {
  const elements = new Map();
  for (const tag of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(tag[0]);
    element.disabled = /\bdisabled\b/.test(tag[0]);
    elements.set(tag[1], element);
  }
  const document = new Events();
  document.hidden = false;
  document.getElementById = id => {
    assert.ok(elements.has(id), 'Missing actual HTML element: ' + id);
    return elements.get(id);
  };
  document.createElement = () => new Element();
  document.getElementById('csv-preview').parentElement = new Element();
  const window = new Events();
  window.SUPABASE_CONFIG = config;
  window.confirm = () => true;
  const values = new Map();
  const localStorage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const timers = new Map();
  const requests = [];
  let clock = 0;
  let timerId = 0;
  let session = 0;
  class BrowserURL extends URL {
    static createObjectURL() { return 'blob:test'; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    window, document, localStorage, URL: BrowserURL, Blob, TextEncoder, AbortController,
    atob, crypto: {randomUUID: () => 'session-' + ++session},
    performance: {now: () => clock}, console: {log() {}},
    navigator: {clipboard: {writeText: async () => {}}},
    Audio: class { play() { return Promise.resolve(); } },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, {callback, due: clock + delay});
      return id;
    },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      assert.equal(url, config.url + '/rest/v1/rpc/upload_reaction_trials');
      const request = {url, options, rows: JSON.parse(options.body).trials};
      requests.push(request);
      return respond(request, requests.length);
    }
  });
  for (const file of ['results-store.js', 'sketch.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const get = id => document.getElementById(id);
  const click = element => {
    if (typeof element === 'string') element = get(element);
    if (element.disabled) return;
    const event = {target: element, detail: 1, button: 0};
    document.emit('click', event);
    element.emit('click', event);
  };
  return {
    get, click, requests, window, document,
    begin() {
      get('participant').value = '01';
      get('session-form').emit('submit');
    },
    trial() {
      click('start');
      const target = get('targets').children.find(button => button.classList.contains('lit'));
      assert.ok(target, 'The actual experiment must light a target');
      clock += 125;
      click(target);
    },
    async advance(milliseconds) {
      const end = clock + milliseconds;
      await settle();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        clock = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      clock = end;
      await settle();
    }
  };
}

async function completeExperiment(app) {
  app.begin();
  for (let block = 1; block <= 3; block++) {
    const before = app.requests.length;
    for (let trial = 1; trial <= 20; trial++) {
      app.trial();
      if (trial < 20) {
        await settle();
        assert.equal(app.requests.length, before, 'No uploads during active or ready trials');
      }
    }
    await settle();
    if (block < 3) app.click('continue');
  }
}

test('all 60 actual pointer trials upload, including block 3, and completion waits for the final save', async () => {
  let resolveFinal;
  const app = browser(request => request.rows.some(row => row.block_number === 3)
    ? new Promise(resolve => { resolveFinal = resolve; }) : success());
  await completeExperiment(app);
  const uploaded = app.requests.flatMap(request => request.rows);
  assert.equal(uploaded.length, 60);
  assert.deepEqual(uploaded.filter(row => row.block_number === 3).map(row => row.trial_number),
    Array.from({length: 20}, (_, i) => i + 1));
  assert.equal(app.get('results').hidden, false);
  assert.equal(app.get('results-title').textContent, 'Saving results…');
  assert.match(app.get('completion-status').textContent, /keep this page open/i);
  assert.equal(app.get('new-session').disabled, true);
  app.click('new-session');
  assert.equal(app.get('results').hidden, false, 'Pending data cannot be discarded through the completion button');
  resolveFinal(success());
  await settle();
  assert.equal(app.get('results-title').textContent, 'Test complete');
  assert.match(app.get('completion-status').textContent, /all results saved/i);
  assert.equal(app.get('new-session').disabled, false);
});

test('a failed final upload retries automatically and retains the exact final 20 records', async () => {
  let finalAttempts = 0;
  const app = browser(request => request.rows.some(row => row.block_number === 3) && ++finalAttempts === 1
    ? failure() : success());
  await completeExperiment(app);
  assert.equal(finalAttempts, 1);
  assert.equal(app.get('new-session').disabled, true);
  await app.advance(999);
  assert.equal(finalAttempts, 1);
  await app.advance(1);
  assert.equal(finalAttempts, 2);
  assert.deepEqual(app.requests[3].rows, app.requests[2].rows);
  assert.equal(app.get('results-title').textContent, 'Test complete');
  assert.equal(app.get('new-session').disabled, false);
});

test('retries stop after three attempts and a CSV backup unlocks the next participant', async () => {
  const app = browser(request => request.rows.some(row => row.block_number === 3) ? failure() : success());
  await completeExperiment(app);
  await app.advance(1000 + 3000 + 10000 + 30000);
  assert.equal(app.requests.length, 6, 'Two saved blocks plus the initial final upload and three retries');
  assert.equal(app.get('results-title').textContent, 'Saving results…');
  assert.equal(app.get('new-session').disabled, true);
  app.click('download');
  assert.equal(app.get('new-session').disabled, false);
  assert.match(app.get('completion-status').textContent, /keep this page open/i);
});

test('a scheduled retry waits until a safe point if the participant starts the next block', async () => {
  const app = browser((request, attempt) => attempt === 1 ? failure() : success());
  app.begin();
  for (let trial = 0; trial < 20; trial++) app.trial();
  await settle();
  app.click('continue');
  await app.advance(500);
  assert.equal(app.requests.length, 1, 'No retry while waiting to start a trial');
  app.click('start');
  await app.advance(500);
  assert.equal(app.requests.length, 1, 'The retry timer cannot upload during an active trial');
  app.click(app.get('targets').children.find(button => button.classList.contains('lit')));
  for (let trial = 1; trial < 20; trial++) app.trial();
  await settle();
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].rows.length, 40, 'The next block break retries both retained and new records');
});

test('hiding or leaving the page pauses trials and safely uploads completed partial records', async t => {
  for (const lifecycle of ['visibilitychange', 'pagehide']) {
    await t.test(lifecycle, async () => {
      const app = browser();
      app.begin();
      for (let trial = 0; trial < 3; trial++) app.trial();
      await settle();
      assert.equal(app.requests.length, 0);
      if (lifecycle === 'visibilitychange') {
        app.click('start');
        app.document.hidden = true;
        app.document.emit('visibilitychange');
      } else app.window.emit('pagehide');
      await settle();
      assert.equal(app.get('overlay-title').textContent, 'Test paused');
      assert.equal(app.requests.length, 1);
      assert.deepEqual(app.requests[0].rows.map(row => row.trial_number), [1, 2, 3]);
      assert.ok(app.get('targets').children.every(button => !button.classList.contains('lit')));
    });
  }
});
