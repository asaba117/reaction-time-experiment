'use strict';

// Uploads are explicitly triggered at breaks/end, never awaited by trial timing.
function createResultsStore(config = {}, dependencies = {}) {
  let storage = dependencies.storage;
  if (!storage) { 
    try { 
      storage = globalThis.localStorage; 
    } catch {} 
  }

  const request = dependencies.fetch ?? globalThis.fetch;
  const randomUUID = dependencies.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const onChange = dependencies.onChange ?? (() => {});
  const timeoutMs = dependencies.timeoutMs ?? 15000;
  const canUpload = dependencies.canUpload ?? (() => true);
  // Keep requests below the browser's 64 KiB keepalive body limit, including
  // restored queues containing more than one participant's results.
  const maxUploadBytes = 48 * 1024;
  const encoder = new TextEncoder();
  const requestedIds = new Set();
  let endpoint = '';
  let uploadEndpoint = '';
  let configurationError = '';
  let pending = [];
  let inFlight = null;
  let lastError = '';
  let recoveryError = '';
  let durable = true;
  let restored = false;
  let uploaded = 0;
  const key = String(config.publishableKey || '').trim();
  const table = config.table || 'reaction_trials';
  const uploadFunction = config.uploadFunction || 'upload_reaction_trials';

  try {
    if (config.url || key) {
      const rawUrl = String(config.url || '').trim();
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') throw Error('Use an HTTPS Supabase project URL.');
      if (!/^[a-z][a-z0-9_]*$/.test(table)) throw Error('Use a valid table name.');
      if (!/^[a-z][a-z0-9_]*$/.test(uploadFunction)) throw Error('Use a valid upload function name.');
      if (!key || key.startsWith('sb_secret_')) throw Error('Use a publishable or anon key, never a secret or service-role key.');
      if (!key.startsWith('sb_publishable_')) {
        let role;
        try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch {}
        if (role !== 'anon') throw Error('Use a publishable or anon key, never a secret or service-role key.');
      }
      endpoint = url.origin + '/rest/v1/' + table;
      uploadEndpoint = url.origin + '/rest/v1/rpc/' + uploadFunction;
    }
  } catch (error) { configurationError = error.message; }
  // Each immutable trial has its own key. Tabs never rewrite a shared array,
  // and acknowledging a batch removes only the records in that batch.
  const legacyKeyName = 'reaction-lab-upload-v1:' + endpoint;
  const recordPrefix = 'reaction-lab-upload-v2:' + endpoint + ':';
  const recordKey = id => recordPrefix + id;
  function numeric(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) {
      throw new TypeError('Trial fields must be finite numbers.');
    }
    return Number(value);
  }
  function integer(value, min, max) {
    const number = numeric(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new TypeError('Trial field is outside its allowed range.');
    }
    return number;
  }
  function normalizeRecord(record) {
    if (!record || typeof record !== 'object') throw new TypeError('Invalid trial record.');
    const id = record.client_record_id || record.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new TypeError('A trial ID is required.');
    const elapsed = numeric(record.elapsed_time_ms ?? record.elapsedTime);
    if (elapsed < 0 || elapsed > 2147483647) throw new TypeError('Invalid elapsed time.');
    return {
      client_record_id: id,
      participant_number: integer(record.participant_number ?? record.user, 0, 999999),
      block_number: integer(record.block_number ?? record.block, 1, 3),
      trial_number: integer(record.trial_number ?? record.trial, 1, 20),
      elapsed_time_ms: Math.round(elapsed),
      error_count: integer(record.error_count ?? record.numberOfErrors ?? 0, 0, 2147483647)
    };
  }
  function restoreRecord(record) {
    const normalized = normalizeRecord(record);
    if (!pending.some(item => item.client_record_id === normalized.client_record_id)) {
      pending.push(normalized);
    }
    return normalized;
  }
  function recoveryFailed() {
    // Keep this separate from transient upload errors. Later successful writes
    // must not hide a backup that could not be read or validated.
    recoveryError = 'Some saved trials could not be restored. Original backups were kept; keep a CSV copy.';
  }
  if (endpoint) {
    const keys = [];
    try {
      // Snapshot keys before reading values; another tab may acknowledge rows.
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name?.startsWith(recordPrefix)) keys.push(name);
      }
    } catch { recoveryFailed(); }
    for (const name of keys) {
      try {
        const value = storage.getItem(name);
        if (value === null) continue;
        const record = normalizeRecord(JSON.parse(value));
        if (recordKey(record.client_record_id) !== name) throw new TypeError('Mismatched backup ID.');
        restoreRecord(record);
      } catch { recoveryFailed(); }
    }
    try {
      // Migrate valid legacy entries independently; retain the original array
      // if any entry could not be recovered or durably copied.
      const legacy = storage.getItem(legacyKeyName);
      if (legacy !== null) {
        const records = JSON.parse(legacy);
        if (!Array.isArray(records)) throw new TypeError('Invalid legacy backup.');
        let complete = true;
        for (const record of records) {
          try {
            const normalized = restoreRecord(record);
            storage.setItem(recordKey(normalized.client_record_id), JSON.stringify(normalized));
          } catch { complete = false; recoveryFailed(); }
        }
        if (complete && storage.getItem(legacyKeyName) === legacy) storage.removeItem(legacyKeyName);
      }
    } catch { recoveryFailed(); }
    restored = pending.length > 0;
  }
  function status() {
    return {configured: Boolean(endpoint), configurationError, pending: pending.length, uploading: Boolean(inFlight), lastError, recoveryError, durable: durable && !recoveryError, restored, uploaded};
  }
  function emit() { onChange(status()); }
  function persist() {
    try {
      for (const record of pending) {
        const id = record.client_record_id || record.id;
        storage.setItem(recordKey(id), JSON.stringify(record));
      }
      durable = true;
    } catch { durable = false; }
  }
  function enqueue(sessionId, row) {
    if (!endpoint) return;
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('A session ID is required.');
    const record = normalizeRecord({...row, client_record_id: sessionId});
    record.client_record_id = sessionId + ':' + record.block_number + ':' + record.trial_number;
    if (record.client_record_id.length > 200) throw new TypeError('Trial ID is too long.');
    if (pending.some(item => item.client_record_id === record.client_record_id)) return;
    pending.push(record);
    persist();
    // No status updates during an active trial; the caller renders at safe points.
  }
  function requestedBatch() {
    const batch = [];
    let bytes = encoder.encode('{"trials":[]}').byteLength;
    for (const record of pending) {
      if (!requestedIds.has(record.client_record_id)) continue;
      const addedBytes = encoder.encode(JSON.stringify(record)).byteLength + (batch.length ? 1 : 0);
      if (bytes + addedBytes > maxUploadBytes) break;
      batch.push(record);
      bytes += addedBytes;
    }
    return batch;
  }
  function flush() {
    if (!endpoint) { emit(); return Promise.resolve(); }
    // A flush requests the records that exist now. Enqueue alone never starts
    // more requests during the next block's timed trials.
    for (const record of pending) requestedIds.add(record.client_record_id || record.id);
    if (inFlight) return inFlight;
    if (!requestedIds.size || !canUpload()) { emit(); return Promise.resolve(); }
    lastError = '';
    inFlight = Promise.resolve().then(async () => {
      try {
        while (requestedIds.size && canUpload()) {
          const batch = requestedBatch();
          if (!batch.length) { requestedIds.clear(); break; }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const headers = {
              apikey: key,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            };
            // Publishable keys go only in apikey; legacy anon JWTs also use Bearer.
            if (!key.startsWith('sb_publishable_')) headers.Authorization = 'Bearer ' + key;
            // The insert-only RPC ignores duplicate client IDs without exposing
            // study data through the SELECT policies required by REST upserts.
            const response = await request(uploadEndpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify({trials: batch}),
              keepalive: true,
              signal: controller.signal
            });
            if (!response.ok) {
              let detail = '';
              try {
                const errJson = await response.json();
                detail = errJson.message || errJson.hint || errJson.error || '';
              } catch {}
              throw Error('Database upload failed (HTTP ' + response.status + (detail ? ': ' + detail : '') + ').');
            }
            const sent = new Set(batch.map(row => row.client_record_id || row.id));
            pending = pending.filter(row => !sent.has(row.client_record_id || row.id));
            for (const id of sent) {
              requestedIds.delete(id);
              try { storage.removeItem(recordKey(id)); }
              catch { durable = false; } // A retained backup can safely replay.
            }
            uploaded += batch.length;
          } catch (error) {
            lastError = error.name === 'AbortError'
              ? 'Database upload timed out.'
              : (error.message || 'Database upload failed. Check the connection and database setup.');
            // Stop on failure, retaining all unsent rows and stable IDs for an
            // explicit retry or the next safe point. Never spin on an outage.
            requestedIds.clear();
            break;
          } finally {
            clearTimeout(timeout);
          }
        }
      } finally {
        inFlight = null;
        emit();
      }
    });
    emit();
    return inFlight;
  }
  return {status, enqueue, flush, newSession: () => endpoint ? randomUUID() : null};
}
if (typeof module !== 'undefined' && module.exports) module.exports = {createResultsStore};
else window.createResultsStore = createResultsStore;
