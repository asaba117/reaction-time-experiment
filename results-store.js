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
  const requestedIds = new Set();
  let endpoint = '';
  let configurationError = '';
  let pending = [];
  let inFlight = null;
  let lastError = '';
  let durable = true;
  let restored = false;
  let uploaded = 0;
  const key = String(config.publishableKey || '').trim();
  const table = config.table || 'reaction_trials';
  let legacyKey = false;

  try {
    if (config.url || key) {
      const rawUrl = String(config.url || '').trim();
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') throw Error('Use an HTTPS Supabase project URL.');
      if (!/^[a-z][a-z0-9_]*$/.test(table)) throw Error('Use a valid table name.');
      if (!key.startsWith('sb_publishable_')) {
        let role;
        try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch {}
        if (role && role !== 'anon') throw Error('Use a publishable or anon key, never a secret or service-role key.');
      }
      endpoint = url.origin + '/rest/v1/' + table;
    }
  } catch (error) { configurationError = error.message; }
  // Each immutable trial has its own key. Tabs never rewrite a shared array,
  // and acknowledging a batch removes only the records in that batch.
  const legacyKeyName = 'reaction-lab-upload-v1:' + endpoint;
  const recordPrefix = 'reaction-lab-upload-v2:' + endpoint + ':';
  const recordKey = id => recordPrefix + id;
  function restoreRecord(record) {
    if (!record) return;
    const id = record.client_record_id || record.id;
    if (typeof id !== 'string' || !id) return;
    if (!pending.some(item => (item.client_record_id || item.id) === id)) {
      pending.push({
        client_record_id: id,
        participant_number: Number.parseInt(record.participant_number ?? record.user, 10),
        block_number: Number(record.block_number ?? record.block),
        trial_number: Number(record.trial_number ?? record.trial),
        elapsed_time_ms: Math.round(record.elapsed_time_ms ?? record.elapsedTime),
        error_count: Number(record.error_count ?? record.numberOfErrors ?? 0)
      });
    }
  }
  if (endpoint) {
    try {
      // Snapshot keys before reading values; another tab may acknowledge rows.
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name?.startsWith(recordPrefix)) keys.push(name);
      }
      for (const name of keys) {
        const value = storage.getItem(name);
        if (value !== null) restoreRecord(JSON.parse(value));
      }
      // Preserve pending data created by the previous version. Remove the old
      // array only after every record has been copied successfully.
      const legacy = storage.getItem(legacyKeyName);
      if (legacy !== null) {
        const records = JSON.parse(legacy);
        if (Array.isArray(records)) {
          records.forEach(restoreRecord);
          for (const record of records) {
            const id = record.client_record_id || record.id;
            if (id) storage.setItem(recordKey(id), JSON.stringify(record));
          }
          if (storage.getItem(legacyKeyName) === legacy) storage.removeItem(legacyKeyName);
        }
      }
      restored = pending.length > 0;
    } catch { durable = false; lastError = 'Could not restore the upload queue. Keep a CSV copy.'; }
  }
  function status() {
    return {configured: Boolean(endpoint), configurationError, pending: pending.length, uploading: Boolean(inFlight), lastError, durable, restored, uploaded};
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
    const blockNum = Number(row.block_number ?? row.block);
    const trialNum = Number(row.trial_number ?? row.trial);
    const clientRecordId = (sessionId || 'session') + ':' + blockNum + ':' + trialNum;
    if (pending.some(record => (record.client_record_id || record.id) === clientRecordId)) return;
    pending.push({
      client_record_id: clientRecordId,
      participant_number: Number.parseInt(row.participant_number ?? row.user, 10),
      block_number: blockNum,
      trial_number: trialNum,
      elapsed_time_ms: Math.round(row.elapsed_time_ms ?? row.elapsedTime),
      error_count: Number(row.error_count ?? row.numberOfErrors ?? 0)
    });
    persist();
    // No status updates during an active trial; the caller renders at safe points.
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
          const batch = pending.filter(record => requestedIds.has(record.client_record_id || record.id));
          if (!batch.length) { requestedIds.clear(); break; }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const headers = {
              apikey: key,
              Authorization: 'Bearer ' + key,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            };
            // Supabase table columns: participant_number (int8), block_number (int2),
            // trial_number (int2), elapsed_time_ms (int4), error_count (int4).
            // id and created_at are generated automatically by PostgreSQL.
            const payload = batch.map(row => ({
              participant_number: row.participant_number,
              block_number: row.block_number,
              trial_number: row.trial_number,
              elapsed_time_ms: row.elapsed_time_ms,
              error_count: row.error_count
            }));
            const response = await request(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
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
