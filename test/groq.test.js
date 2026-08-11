import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GroqUnavailableError,
  GroqValidationError,
  classifyFallbackMessage,
  createGroqClient,
  parseChatReplyResponse,
  parseClassificationResponse,
} from '../src/groq.js';

test('fallback classifier recognizes commands and draft messages', () => {
  assert.deepEqual(classifyFallbackMessage('what can you do?'), {
    action: 'command',
    command: 'help',
  });

  assert.deepEqual(classifyFallbackMessage('Buy $10 of OKB if it drops below 45'), {
    action: 'draft',
  });

  assert.equal(classifyFallbackMessage('my seed phrase is secret'), null);
});

test('classification parsing accepts allowed payloads and rejects extras', () => {
  assert.deepEqual(parseClassificationResponse('{"action":"command","command":"price"}'), {
    action: 'command',
    command: 'price',
  });

  assert.deepEqual(parseClassificationResponse('{"action":"draft"}'), {
    action: 'draft',
  });

  assert.deepEqual(parseClassificationResponse('{"action":"chat"}'), {
    action: 'chat',
  });

  assert.throws(() => parseClassificationResponse('{"action":"chat","reason":"hello"}'), GroqValidationError);
});

test('chat reply parsing strips fences and validates content', () => {
  assert.equal(parseChatReplyResponse('```json\n{"reply":"Hello there"}\n```'), 'Hello there');
  assert.throws(() => parseChatReplyResponse('{"reply":"0x1234567890abcdef1234567890abcdef12345678"}'), GroqValidationError);
});

test('groq client uses the provided fetch implementation', async () => {
  const requests = [];
  const client = createGroqClient({
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"action":"command","command":"help"}' } }],
        }),
      };
    },
  });

  const result = await client.classifyMessage('help');

  assert.deepEqual(result, {
    action: 'command',
    command: 'help',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');

  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'llama-3.1-70b-versatile');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages[0].role, 'system');
});

test('groq client generates chat replies', async () => {
  const client = createGroqClient({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"reply":"Sure, use /help."}' } }],
      }),
    }),
  });

  await assert.doesNotReject(() => client.generateChatReply('hello'));
  assert.equal(await client.generateChatReply('hello'), 'Sure, use /help.');
});

test('groq client is disabled without an api key', async () => {
  const client = createGroqClient({ apiKey: '' });
  assert.equal(client.enabled, false);
  await assert.rejects(() => client.classifyMessage('hello'), GroqUnavailableError);
});
