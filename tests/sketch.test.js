'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const header = 'user#,block#,trial#,elapsedTime,numberOfErrors';
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
}

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
    Object.assign(this, {children: [], attributes: new Map(), className: '', style: {}, dataset: {},
      hidden: false, disabled: false, value: '', textContent: ''});
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
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

// Execute the scripts declared by the real HTML, with observable download and
// clipboard APIs, rather than substituting an implementation of the experiment.
function browser({storage = memoryStorage(), clipboard = true, confirm = () => true, legacyMarkup = false} = {}) {
  let markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (legacyMarkup) markup = markup.replace(/<p\b[^>]*\bid="completion-status"[^>]*>[\s\S]*?<\/p>/, '');
  const elements = new Map();
  for (const tag of markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(tag[0]);
    element.disabled = /\bdisabled\b/.test(tag[0]);
    element.textContent = markup.slice(tag.index + tag[0].length).match(/^([^<]*)</)?.[1] ?? '';
    elements.set(tag[1], element);
  }
  const document = new Events();
  const window = new Events();
  const downloads = [];
  const copied = [];
  const confirmations = [];
  const network = [];
  const blobs = new Map();
  let clock = 0;
  document.hidden = false;
  document.getElementById = id => elements.get(id) ?? null;
  document.createElement = tag => {
    const element = new Element();
    if (tag === 'a') element.click = () => downloads.push({filename: element.download, blob: blobs.get(element.href)});
    return element;
  };
  document.getElementById('csv-preview').parentElement = new Element();
  window.confirm = message => { confirmations.push(message); return confirm(); };
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = 'blob:test-' + blobs.size; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { blobs.delete(url); }
  }
  const context = vm.createContext({
    window, document, localStorage: storage, URL: BrowserURL, Blob,
    performance: {now: () => clock}, console: {log() {}},
    navigator: {clipboard: {writeText: async text => {
      if (!clipboard) throw Error('Clipboard unavailable');
      copied.push(text);
    }}},
    Audio: class { play() { return Promise.resolve(); } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: (...args) => { network.push(args); throw Error('Unexpected network request from experiment'); }
  });
  const scripts = [...markup.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1].split('?')[0]);
  for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  const get = id => document.getElementById(id);
  const click = element => {
    if (typeof element === 'string') element = get(element);
    if (element.disabled) return;
    const event = {target: element, detail: 1, button: 0};
    document.emit('click', event);
    element.emit('click', event);
  };
  return {
    get, click, downloads, copied, confirmations, network, scripts,
    begin(user = '01') { get('participant').value = user; get('session-form').emit('submit'); },
    trial({miss = false} = {}) {
      click('start');
      const target = get('targets').children.find(button => button.classList.contains('lit'));
      assert.ok(target, 'The actual experiment must light a target');
      if (miss) click('arena');
      clock += 125;
      click(target);
    },
    unload() {
      const event = {prevented: false, preventDefault() { this.prevented = true; }};
      window.emit('beforeunload', event);
      return event;
    }
  };
}

function completeExperiment(app) {
  app.begin();
  for (let block = 1; block <= 3; block++) {
    for (let trial = 1; trial <= 20; trial++) app.trial({miss: block === 1 && trial === 1});
    if (block < 3) app.click('continue');
  }
}

test('all 60 pointer trials export complete CSV data through downloads and copying without network calls', async () => {
  const app = browser();
  completeExperiment(app);
  assert.deepEqual(app.scripts, ['sketch.js']);
  assert.equal(app.network.length, 0);
  assert.equal(app.get('results').hidden, false);
  assert.equal(app.get('results-title').textContent, 'Test complete');
  assert.match(app.get('completion-status').textContent, /download.*csv.*send/i);
  const csv = app.get('csv-preview').value;
  const [actualHeader, ...records] = csv.trimEnd().split('\r\n');
  assert.equal(actualHeader, header);
  assert.equal(records.length, 60);
  records.forEach((record, index) => assert.deepEqual(record.split(','),
    ['01', String(Math.floor(index / 20) + 1), String(index % 20 + 1), '125', index === 0 ? '1' : '0']));
  app.click('download');
  assert.equal(app.downloads[0].filename, 'reaction-time-participant-01.csv');
  assert.equal(app.downloads[0].blob.type, 'text/csv;charset=utf-8;');
  assert.equal(await app.downloads[0].blob.text(), csv);
  app.click('copy');
  await settle();
  assert.deepEqual(app.copied, [csv]);
  assert.equal(app.unload().prevented, false);
  app.click('new-session');
  assert.equal(app.confirmations.length, 0);
  assert.equal(app.get('setup').hidden, false);
});

test('starting another participant requires confirmation until results have been exported', () => {
  let allow = false;
  const app = browser({confirm: () => allow});
  completeExperiment(app);
  app.click('new-session');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.get('results').hidden, false);
  allow = true;
  app.click('new-session');
  assert.equal(app.confirmations.length, 2);
  assert.equal(app.get('results').hidden, true);
  assert.equal(app.get('setup').hidden, false);
});

test('unexported trials warn before closing, and new trials require another export', () => {
  const app = browser();
  assert.equal(app.unload().prevented, false);
  app.begin();
  app.trial();
  assert.equal(app.unload().prevented, true);
  assert.equal(app.unload().returnValue, '');
  app.click('download-partial');
  assert.equal(app.unload().prevented, false);
  app.trial();
  assert.equal(app.unload().prevented, true);
});

test('clipboard failure selects the visible CSV fallback and preserves the export warning', async () => {
  const app = browser({clipboard: false});
  completeExperiment(app);
  app.click('copy');
  await settle();
  assert.equal(app.get('csv-preview').parentElement.open, true);
  assert.equal(app.get('csv-preview').selected, true);
  assert.match(app.get('export-status').textContent, /Ctrl\+C/);
  assert.equal(app.unload().prevented, true);
});

test('the same browser can download its previous session after reopening', async () => {
  const storage = memoryStorage();
  const first = browser({storage});
  first.begin();
  for (let trial = 0; trial < 3; trial++) first.trial();
  first.click('download-partial');
  const expected = await first.downloads[0].blob.text();
  const reopened = browser({storage});
  assert.equal(reopened.get('recover').hidden, false);
  reopened.click('recover');
  assert.equal(reopened.downloads[0].filename, 'reaction-time-participant-01.csv');
  assert.equal(await reopened.downloads[0].blob.text(), expected);
});

test('unavailable browser storage still permits all 60 trials and a complete CSV download', async () => {
  const app = browser({storage: {getItem() { throw Error('Storage blocked'); }, setItem() { throw Error('Storage blocked'); }}});
  completeExperiment(app);
  assert.equal(app.get('storage-warning').hidden, false);
  app.click('download');
  assert.equal((await app.downloads[0].blob.text()).trimEnd().split('\r\n').length, 61);
});

test('cached markup without the new completion paragraph still displays and exports every block', () => {
  const app = browser({legacyMarkup: true});
  assert.equal(app.get('completion-status'), null);
  completeExperiment(app);
  assert.equal(app.get('results').hidden, false);
  assert.equal(app.get('csv-preview').value.trimEnd().split('\r\n').length, 61);
  assert.equal(app.network.length, 0);
});
