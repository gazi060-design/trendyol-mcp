import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCompactQuestionTools } from '../dist/compact-questions.js';

const config = {
  baseUrl: 'https://example.test',
  stores: { mybook: { alias: 'mybook', sellerId: '123', apiKey: 'key', apiSecret: 'secret', userAgent: 'unit-test' } }
};

function setup() {
  let handler;
  registerCompactQuestionTools({ registerTool(name, _meta, fn) {
    if (name === 'trendyol_poll_pending_questions') handler = fn;
  } }, config);
  assert.equal(typeof handler, 'function');
  return handler;
}

test('compact polling returns only essential fields and source pagination', async () => {
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => {
    requested = new URL(url);
    return new Response(JSON.stringify({
      page: 0, totalPages: 2, totalElements: 2,
      content: [{ id: 42, text: 'Stock?', barcode: 'A', public: true,
        customerEmail: 'private@example.com', otherLargeField: 'hidden' }]
    }), { status: 200 });
  };
  try {
    const handler = setup();
    const response = await handler({ store: 'mybook', page: 0, size: 1, privateOnly: false });
    const data = JSON.parse(response.content[0].text);
    assert.equal(requested.searchParams.get('status'), 'WAITING_FOR_ANSWER');
    assert.equal(requested.searchParams.get('size'), '1');
    assert.equal(data.nextPage, 1);
    assert.equal(data.questions[0].id, 42);
    assert.equal(response.content[0].text.includes('private@example.com'), false);
    assert.equal(response.content[0].text.includes('otherLargeField'), false);
  } finally { globalThis.fetch = original; }
});

test('private filter does not falsely signal end of source pages', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    page: 0, totalPages: 3, content: [{ id: 1, public: true }]
  }), { status: 200 });
  try {
    const data = JSON.parse((await setup()({ store: 'mybook', page: 0, size: 100, privateOnly: true })).content[0].text);
    assert.deepEqual(data.questions, []);
    assert.equal(data.nextPage, 1);
  } finally { globalThis.fetch = original; }
});
