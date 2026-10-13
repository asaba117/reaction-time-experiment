'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createResultsStore} = require('../results-store.js');

const config = {url: 'https://experiment.supabase.co', publishableKey: 'sb_publishable_test'};
const endpoint = config.url + '/rest/v1/reaction_trials';
const prefix = 'reaction-lab-upload-v2:' + endpoint + ':';
const legacyKey = 'reaction-lab-upload-v1:' + endpoint;
const ok = () => ({ok: true, status: 201});
const row = overrides => ({user: '01', block: 1, trial: 1, elapsedTime: 123.6, numberOfErrors: 0, ...overrides});
const saved = (id, overrides) => ({
  client_record_id: id, participant_number: 1, block_number: 1,
  trial_number: 1, elapsed_time_ms: 124, error_count: 0, ...overrides
});

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function store(storage, fetch, extra = {}) {
  return createResultsStore(config, {storage, fetch, randomUUID: () => 'new-session', ...extra});
}

// Simulate the database's unique constraint, including a committed request whose
// response never reaches the client. Deduplication only applies for the exact
// RPC contract used by production.
function uniqueServer({loseFirstResponse = false} = {}) {
  const rows = new Map();
  const requests = [];
  return {
    rows, requests,
    async fetch(url, options) {
      requests.push({url, ...options});
      assert.equal(url, config.url + '/rest/v1/rpc/upload_reaction_trials');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.apikey, config.publishableKey);
      assert.equal(options.headers.Authorization, undefined, 'publishable keys are not JWT bearer tokens');
      const payload = JSON.parse(options.body).trials;
      assert.ok(Array.isArray(payload));
      for (const record of payload) {
        assert.equal(typeof record.client_record_id, 'string');
        assert.ok(record.client_record_id.length > 0);
        if (!rows.has(record.client_record_id)) rows.set(record.client_record_id, record);
      }
      if (loseFirstResponse && requests.length === 1) throw Error('Connection lost after commit');
      return ok();
    }
  };
}

test('uploads stable client IDs and normalizes the actual trial fields', async () => {
  const storage = memoryStorage();
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  assert.equal(results.newSession(), 'new-session');
  results.enqueue('session-one', row());
  results.enqueue('session-one', row());
  assert.equal(results.status().pending, 1);
  assert.equal(server.requests.length, 0, 'enqueue must not start a network request');
  assert.deepEqual(JSON.parse(storage.getItem(prefix + 'session-one:1:1')), saved('session-one:1:1'));
  await results.flush();
  assert.deepEqual([...server.rows.values()], [saved('session-one:1:1')]);
  assert.equal(results.status().uploaded, 1);
  assert.equal(results.status().pending, 0);
  assert.equal(storage.length, 0);
});

test('retry after a committed request loses its response creates only one database row', async () => {
  const storage = memoryStorage();
  const server = uniqueServer({loseFirstResponse: true});
  const results = store(storage, server.fetch);
  results.enqueue('session-one', row());
  await results.flush();
  assert.equal(server.rows.size, 1);
  assert.equal(results.status().uploaded, 0);
  assert.equal(results.status().pending, 1);
  assert.match(results.status().lastError, /Connection lost/);
  assert.notEqual(storage.getItem(prefix + 'session-one:1:1'), null);
  await results.flush();
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].body, server.requests[1].body);
  assert.equal(server.rows.size, 1);
  assert.equal(results.status().uploaded, 1);
  assert.equal(results.status().pending, 0);
  assert.equal(results.status().lastError, '');
  assert.equal(storage.length, 0);
});

test('two tabs restoring the same backup can safely upload stale copies', async () => {
  const id = 'old-session:1:1';
  const storage = memoryStorage([[prefix + id, JSON.stringify(saved(id))]]);
  const server = uniqueServer();
  const first = store(storage, server.fetch);
  const second = store(storage, server.fetch);
  assert.equal(first.status().pending, 1);
  assert.equal(second.status().pending, 1);
  await first.flush();
  assert.equal(storage.length, 0);
  await second.flush();
  assert.equal(server.requests.length, 2);
  assert.equal(server.rows.size, 1);
  assert.equal(first.status().pending, 0);
  assert.equal(second.status().pending, 0);
});

test('corrupt per-record backups do not strand later valid records or lose their warning', async () => {
  const validId = 'valid-backup';
  const legacyId = 'old-id-format';
  const corruptKey = prefix + 'broken-json';
  const invalidKey = prefix + 'invalid-fields';
  const storage = memoryStorage([
    [corruptKey, '{broken'],
    [invalidKey, JSON.stringify(saved('invalid-fields', {trial_number: 21}))],
    [prefix + validId, JSON.stringify(saved(validId))],
    [prefix + legacyId, JSON.stringify({id: legacyId, ...row({trial: 2})})]
  ]);
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  assert.equal(results.status().pending, 2);
  assert.equal(results.status().restored, true);
  assert.ok(results.status().recoveryError);
  assert.equal(results.status().durable, false);
  const warning = results.status().recoveryError;
  results.enqueue('new-session', row({trial: 3}));
  assert.equal(results.status().recoveryError, warning);
  assert.equal(results.status().durable, false, 'later writes must not hide recovery loss');
  await results.flush();
  assert.deepEqual([...server.rows.keys()].sort(), [legacyId, 'new-session:1:3', validId].sort());
  assert.equal(results.status().pending, 0);
  assert.equal(results.status().lastError, '');
  assert.equal(results.status().recoveryError, warning);
  assert.equal(results.status().durable, false);
  assert.equal(storage.getItem(corruptKey), '{broken');
  assert.notEqual(storage.getItem(invalidKey), null);
  assert.equal(storage.getItem(prefix + validId), null);
  assert.equal(storage.getItem(prefix + legacyId), null);
});

test('legacy array recovery skips bad entries and preserves the source for recovery', async () => {
  const legacy = JSON.stringify([
    null,
    {id: 'legacy-a', ...row()},
    {id: 'bad-legacy', ...row({numberOfErrors: -1})},
    saved('legacy-b', {trial_number: 2}),
    {participant_number: 1}
  ]);
  const storage = memoryStorage([[legacyKey, legacy]]);
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  assert.equal(results.status().pending, 2);
  assert.ok(results.status().recoveryError);
  assert.equal(results.status().durable, false);
  assert.equal(storage.getItem(legacyKey), legacy);
  assert.notEqual(storage.getItem(prefix + 'legacy-a'), null);
  assert.notEqual(storage.getItem(prefix + 'legacy-b'), null);
  await results.flush();
  assert.deepEqual([...server.rows.keys()], ['legacy-a', 'legacy-b']);
  assert.equal(server.rows.get('legacy-b').trial_number, 2);
  assert.equal(storage.getItem(legacyKey), legacy);
  assert.ok(results.status().recoveryError);
});

test('invalid new rows are rejected before changing the queue or uploading', async () => {
  const storage = memoryStorage();
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  const invalidRows = [
    {user: ''}, {user: '  '}, {user: '1extra'}, {user: '1.5'},
    {user: -1}, {user: 1000000}, {user: null},
    {block: 0}, {block: 4}, {block: 1.5}, {block: ''},
    {trial: 0}, {trial: 21}, {trial: 1.5},
    {elapsedTime: -0.1}, {elapsedTime: NaN}, {elapsedTime: Infinity},
    {elapsedTime: 2147483648}, {elapsedTime: ''},
    {numberOfErrors: -1}, {numberOfErrors: 0.5}, {numberOfErrors: 2147483648}
  ];
  for (const bad of invalidRows) {
    assert.throws(() => results.enqueue('invalid', row(bad)), TypeError, JSON.stringify(bad));
    assert.equal(results.status().pending, 0);
    assert.equal(storage.length, 0);
  }
  await results.flush();
  assert.equal(server.requests.length, 0);
});

test('unavailable storage still retains failed uploads in memory for explicit retry', async () => {
  const storage = {
    get length() { throw Error('Storage disabled'); },
    getItem() { throw Error('Storage disabled'); },
    setItem() { throw Error('Storage disabled'); },
    removeItem() { throw Error('Storage disabled'); }
  };
  let online = false;
  const calls = [];
  const results = store(storage, async (url, options) => {
    calls.push(JSON.parse(options.body).trials);
    if (!online) throw Error('Offline');
    return ok();
  });
  results.enqueue('memory-session', row());
  assert.equal(results.status().pending, 1);
  assert.equal(results.status().durable, false);
  await results.flush();
  assert.equal(results.status().pending, 1);
  assert.equal(results.status().uploaded, 0);
  online = true;
  await results.flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(results.status().pending, 0);
  assert.equal(results.status().uploaded, 1);
  assert.equal(results.status().durable, false);
});

test('uploads wait for safe points and enqueue never expands an in-flight batch', async () => {
  const storage = memoryStorage();
  const calls = [];
  let allowed = false;
  let finish;
  const results = store(storage, async (url, options) => {
    calls.push(JSON.parse(options.body).trials);
    await new Promise(resolve => { finish = resolve; });
    return ok();
  }, {canUpload: () => allowed});
  results.enqueue('timed-session', row());
  await results.flush();
  assert.equal(calls.length, 0);
  assert.equal(results.status().pending, 1);
  allowed = true;
  const upload = results.flush();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  results.enqueue('timed-session', row({trial: 2}));
  finish();
  await upload;
  assert.equal(calls.length, 1);
  assert.equal(results.status().pending, 1);
  assert.equal(calls[0].length, 1);
  allowed = false;
  await results.flush();
  assert.equal(calls.length, 1);
  allowed = true;
  const retry = results.flush();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  finish();
  await retry;
  assert.equal(calls[1][0].trial_number, 2);
  assert.equal(results.status().pending, 0);
});

test('valid legacy backups migrate, survive an outage and clear after restored retry', async () => {
  const legacy = [{id: 'legacy-session:1:1', ...row()}];
  const storage = memoryStorage([[legacyKey, JSON.stringify(legacy)]]);
  const offline = store(storage, async () => { throw Error('Offline'); });
  assert.equal(offline.status().pending, 1);
  assert.equal(offline.status().recoveryError, '');
  assert.equal(storage.getItem(legacyKey), null);
  assert.notEqual(storage.getItem(prefix + 'legacy-session:1:1'), null);
  await offline.flush();
  assert.equal(offline.status().pending, 1);
  const server = uniqueServer();
  const restored = store(storage, server.fetch);
  assert.equal(restored.status().restored, true);
  assert.equal(restored.status().durable, true);
  await restored.flush();
  assert.equal(server.rows.size, 1);
  assert.equal(restored.status().pending, 0);
  assert.equal(restored.status().recoveryError, '');
  assert.equal(storage.length, 0);
});


test('new records require a nonempty session ID to avoid cross-participant collisions', async () => {
  const storage = memoryStorage();
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  for (const sessionId of [undefined, null, '', '   ', 123]) {
    assert.throws(() => results.enqueue(sessionId, row()), TypeError);
    assert.equal(results.status().pending, 0);
    assert.equal(storage.length, 0);
  }
  await results.flush();
  assert.equal(server.requests.length, 0);
});

test('legacy anon JWT keys may still authenticate using a bearer header', async () => {
  const jwt = 'header.' + Buffer.from(JSON.stringify({role: 'anon'})).toString('base64url') + '.signature';
  let request;
  const results = createResultsStore({...config, publishableKey: jwt}, {
    storage: memoryStorage(),
    fetch: async (url, options) => { request = {url, ...options}; return ok(); }
  });
  results.enqueue('jwt-session', row());
  await results.flush();
  assert.equal(request.headers.apikey, jwt);
  assert.equal(request.headers.Authorization, 'Bearer ' + jwt);
  assert.equal(results.status().pending, 0);
});


test('canonical field names accept valid zero values and database integer boundaries', async () => {
  const server = uniqueServer();
  const results = store(memoryStorage(), server.fetch);
  results.enqueue('zero', {
    participant_number: 0, block_number: 3, trial_number: 20,
    elapsed_time_ms: 0, error_count: 0
  });
  results.enqueue('max', {
    participant_number: 999999, block_number: 1, trial_number: 1,
    elapsed_time_ms: 2147483647, error_count: 2147483647
  });
  await results.flush();
  assert.equal(server.rows.size, 2);
  assert.deepEqual(server.rows.get('zero:3:20'), saved('zero:3:20', {
    participant_number: 0, block_number: 3, trial_number: 20, elapsed_time_ms: 0
  }));
  assert.equal(server.rows.get('max:1:1').elapsed_time_ms, 2147483647);
  assert.equal(server.rows.get('max:1:1').error_count, 2147483647);
});


test('composed client IDs accept 200 characters and reject longer IDs without mutation', async () => {
  const storage = memoryStorage();
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  const session = 's'.repeat(196);
  const id = session + ':1:1';
  results.enqueue(session, row());
  assert.equal(id.length, 200);
  assert.equal(results.status().pending, 1);
  assert.equal(storage.length, 1);
  assert.throws(() => results.enqueue('s'.repeat(197), row()), TypeError);
  assert.equal(results.status().pending, 1);
  assert.equal(storage.length, 1);
  assert.equal(server.requests.length, 0);
  await results.flush();
  assert.deepEqual([...server.rows.keys()], [id]);
  assert.equal(storage.length, 0);
});

test('oversized restored IDs are skipped without discarding their original backup', async () => {
  const oversized = 'r'.repeat(201);
  const raw = JSON.stringify(saved(oversized));
  const validId = 'r'.repeat(200);
  const storage = memoryStorage([
    [prefix + oversized, raw],
    [prefix + validId, JSON.stringify(saved(validId))]
  ]);
  const server = uniqueServer();
  const results = store(storage, server.fetch);
  assert.equal(results.status().pending, 1);
  assert.ok(results.status().recoveryError);
  assert.equal(results.status().durable, false);
  await results.flush();
  assert.deepEqual([...server.rows.keys()], [validId]);
  assert.equal(storage.getItem(prefix + oversized), raw);
  assert.equal(storage.getItem(prefix + validId), null);
  assert.ok(results.status().recoveryError);
  assert.equal(results.status().durable, false);
});
