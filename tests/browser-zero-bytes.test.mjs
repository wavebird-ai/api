import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublisherAds } from '../dist/browser.js';

test('zero-byte transport chunks do not invent model progress', async () => {
  const priorWindow = globalThis.window, priorDocument = globalThis.document;
  const events = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: () => ({
      prepare: async () => {}, onStarted: () => events.push('started'),
      onDelta: () => events.push('delta'), onDone: () => events.push('done'),
      onAbort: () => events.push('abort'), onError: () => events.push('error'), dispose() {},
    }) },
    addEventListener() {}, removeEventListener() {},
  };
  let ads;
  try {
    ads = createPublisherAds({ target: { append() {} }, clientId: 'wbproj_synthetic',
      surfaceId: 'chat_assistant', jobType: 'chat', userId: 'user_synthetic',
      conversationId: 'conversation_synthetic', timing: 'after', consentMode: 'own_cmp' });
    await ads.ready;
    async function run(chunks) {
      events.length = 0;
      const result = await ads.connectGeneration({
        request: async headers => {
          const records = [
            { type: 'started' }, { type: 'response', status: 200, headers: [] },
            ...chunks.map(data => ({ type: 'bytes', data })), { type: 'done' },
          ];
          const lines = records.map(record => JSON.stringify({
            session_id: headers['x-wavebird-session-id'],
            generation_id: headers['x-wavebird-generation-id'], ...record,
          }) + '\n').join('');
          return new Response(lines, { headers: { 'x-wavebird-generation-transport': '1' } });
        },
        consume: response => response.text(),
      });
      return { result, events: [...events] };
    }
    assert.deepEqual(await run(['']), { result: '', events: ['started', 'done'] });
    assert.deepEqual(await run(['', 'WA==']), { result: 'X', events: ['started', 'delta', 'done'] });
  } finally {
    ads?.dispose();
    globalThis.window = priorWindow; globalThis.document = priorDocument;
  }
});
