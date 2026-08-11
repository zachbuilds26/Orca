const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export const GROQ_DEFAULT_MODEL = 'llama-3.1-70b-versatile';
export const GROQ_ALLOWED_COMMANDS = new Set(['help', 'price', 'chart', 'list', 'status', 'positions', 'risk', 'cancel', 'wallet']);
export const GROQ_ALLOWED_STRATEGIES = new Set(['buy', 'sell', 'takeprofit', 'stoploss', 'dca']);
export const GROQ_MAX_INPUT_CHARS = 1200;
export const GROQ_MAX_REPLY_CHARS = 280;

export class GroqUnavailableError extends Error {
  constructor(message = 'Groq is not configured.') {
    super(message);
    this.name = 'GroqUnavailableError';
    this.code = 'groq_unavailable';
  }
}

export class GroqTimeoutError extends Error {
  constructor(message = 'Groq request timed out.') {
    super(message);
    this.name = 'GroqTimeoutError';
    this.code = 'groq_timeout';
  }
}

export class GroqRequestError extends Error {
  constructor(message = 'Groq request failed.') {
    super(message);
    this.name = 'GroqRequestError';
    this.code = 'groq_request_error';
  }
}

export class GroqValidationError extends Error {
  constructor(message = 'Groq response was invalid.') {
    super(message);
    this.name = 'GroqValidationError';
    this.code = 'groq_validation_error';
  }
}

const SENSITIVE_PATTERNS = [
  /\b(private\s+key|seed\s+phrase|mnemonic|recovery\s+phrase|secret\s+phrase|password)\b/i,
  /\b0x[a-fA-F0-9]{64}\b/,
  /\b0x[a-fA-F0-9]{40}\b/,
];

const DRAFT_HINT = /\b(buy|sell|take\s?profit|takeprofit|stop\s?loss|stoploss|dca|dollar[- ]?cost|average)\b/i;
const DRAFT_CONTEXT_HINT = /\b(okb|usd|usdt|below|under|above|over|less than|more than|drops?|rises?|falls?|hits?|reaches?|every|daily|weekly|monthly|per\s+\d+)\b/i;
const COMMAND_HINTS = [
  ['help', /\b(help|commands|what can you do|how do i use orca|how does orca work)\b/i],
  ['price', /\b(price|live price|okb price|what is the price)\b/i],
  ['chart', /\b(chart|graph|price card)\b/i],
  ['list', /\b(list|intents|rules|show me my intents)\b/i],
  ['status', /\b(status|what is happening|current status|latest status)\b/i],
  ['positions', /\b(positions|open positions|holdings)\b/i],
  ['risk', /\b(risk|exposure|risk check)\b/i],
  ['cancel', /\b(cancel|stop\s+the\s+latest|stop\s+this|abort\s+it)\b/i],
  ['wallet', /\b(connect|link|verify|disconnect|open|manage)\s+wallet\b|\bwallet\b.*\b(connect|link|verify|disconnect|open|manage)\b/i],
];

export function createGroqClient({
  apiKey = '',
  model = GROQ_DEFAULT_MODEL,
  timeoutMs = 4500,
  maxInputChars = GROQ_MAX_INPUT_CHARS,
  maxReplyChars = GROQ_MAX_REPLY_CHARS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedApiKey = String(apiKey || '').trim();
  const normalizedModel = String(model || GROQ_DEFAULT_MODEL).trim();
  const normalizedTimeoutMs = clampPositiveInteger(timeoutMs, 4500);
  const normalizedInputChars = clampPositiveInteger(maxInputChars, GROQ_MAX_INPUT_CHARS);
  const normalizedReplyChars = clampPositiveInteger(maxReplyChars, GROQ_MAX_REPLY_CHARS);

  if (!normalizedApiKey) {
    return disabledClient();
  }

  if (typeof fetchImpl !== 'function') {
    throw new GroqUnavailableError('Fetch is unavailable.');
  }

  return {
    enabled: true,
    async classifyMessage(text) {
      const prompt = normalizeInput(text, normalizedInputChars);
      const content = await requestGroq({
        apiKey: normalizedApiKey,
        model: normalizedModel,
        timeoutMs: normalizedTimeoutMs,
        fetchImpl,
        messages: buildClassificationMessages(prompt),
        maxTokens: 120,
        temperature: 0,
      });
      return parseClassificationResponse(content);
    },
    async generateChatReply(text) {
      const prompt = normalizeInput(text, normalizedInputChars);
      const content = await requestGroq({
        apiKey: normalizedApiKey,
        model: normalizedModel,
        timeoutMs: normalizedTimeoutMs,
        fetchImpl,
        messages: buildChatMessages(prompt),
        maxTokens: 180,
        temperature: 0.4,
      });
      return parseChatReplyResponse(content, normalizedReplyChars);
    },
  };
}

export function classifyFallbackMessage(text, { maxInputChars = GROQ_MAX_INPUT_CHARS } = {}) {
  const input = normalizeInput(text, maxInputChars);

  if (!input || containsSensitiveContent(input)) {
    return null;
  }

  const command = detectCommandKey(input);
  if (command) {
    return { action: 'command', command };
  }

  if (isLikelyDraftText(input)) {
    return { action: 'draft' };
  }

  return null;
}

export function isLikelyDraftText(text) {
  const input = normalizeInput(text, GROQ_MAX_INPUT_CHARS);
  if (!input || containsSensitiveContent(input)) {
    return false;
  }

  if (!DRAFT_HINT.test(input)) {
    return false;
  }

  return DRAFT_CONTEXT_HINT.test(input) || /\bOKB\b/i.test(input) || /\$\d+/i.test(input);
}

export function parseClassificationResponse(content) {
  const parsed = parseJsonResponse(content);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GroqValidationError('Groq classification did not return an object.');
  }

  const keys = Object.keys(parsed);
  const action = normalizeAction(parsed.action);

  if (!action) {
    throw new GroqValidationError('Groq classification is missing an action.');
  }

  if (action === 'command') {
    if (!keys.every((key) => key === 'action' || key === 'command')) {
      throw new GroqValidationError('Groq command classification included unsupported fields.');
    }

    const command = normalizeCommand(parsed.command);
    if (!command) {
      throw new GroqValidationError('Groq command classification included an invalid command.');
    }

    return { action, command };
  }

  if (action === 'draft') {
    if (!keys.every((key) => key === 'action')) {
      throw new GroqValidationError('Groq draft classification included unsupported fields.');
    }

    return { action };
  }

  if (action === 'chat') {
    if (!keys.every((key) => key === 'action')) {
      throw new GroqValidationError('Groq chat classification included unsupported fields.');
    }

    return { action };
  }

  throw new GroqValidationError('Groq classification returned an unknown action.');
}

export function parseChatReplyResponse(content, maxReplyChars = GROQ_MAX_REPLY_CHARS) {
  const parsed = parseJsonResponse(content);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GroqValidationError('Groq chat reply did not return an object.');
  }

  const keys = Object.keys(parsed);
  if (!keys.every((key) => key === 'reply')) {
    throw new GroqValidationError('Groq chat reply included unsupported fields.');
  }

  const reply = normalizeOutputText(parsed.reply, maxReplyChars);

  if (!reply || containsSensitiveContent(reply)) {
    throw new GroqValidationError('Groq chat reply was invalid.');
  }

  return reply;
}

async function requestGroq({ apiKey, model, timeoutMs, fetchImpl, messages, maxTokens, temperature }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(GROQ_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response?.ok) {
      const bodyText = await safeResponseText(response);
      const error = new GroqRequestError(`Groq request failed (${response?.status || 'unknown'}).`);
      error.status = response?.status || null;
      error.body = truncateText(bodyText, 200);
      throw error;
    }

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new GroqValidationError('Groq response did not include message content.');
    }

    return content;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new GroqTimeoutError();
    }

    if (error instanceof GroqRequestError || error instanceof GroqValidationError || error instanceof GroqTimeoutError) {
      throw error;
    }

    const wrapped = new GroqRequestError(error?.message ? `Groq request failed: ${error.message}` : 'Groq request failed.');
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeResponseText(response) {
  if (!response?.text) {
    return '';
  }

  try {
    return await response.text();
  } catch {
    return '';
  }
}

function buildClassificationMessages(text) {
  return [
    {
      role: 'system',
      content: [
        'You route Orca Telegram messages.',
        'Return JSON only.',
        'Choose exactly one action: command, draft, or chat.',
        'For command, return one allowlisted command only: help, price, chart, list, status, positions, risk, cancel, wallet.',
        'For draft, return only {"action":"draft"} when the user clearly wants to create a rule.',
        'For chat, return only {"action":"chat"} for unsupported, conversational, or unclear text.',
        'Never include strategies, amounts, trigger prices, wallet addresses, confirmation, expiry, cadence, shell commands, or execution instructions.',
        'Never confirm transfers, link or unlink wallets, or bypass Orca buttons and confirmations.',
      ].join(' '),
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

function buildChatMessages(text) {
  return [
    {
      role: 'system',
      content: [
        'You are Orca, a Telegram-native X Layer testnet assistant.',
        'Reply in 1 or 2 short sentences.',
        'Stay under 280 characters.',
        'Do not mention private keys, seed phrases, wallet addresses, or onchain execution details.',
        'Do not invent wallet state or prices.',
        'If the user asks for unsupported actions, gently redirect them to Orca commands like /wallet, /buy, /sell, /takeprofit, /stoploss, /dca, /status, /positions, /risk, /price, /chart, or /help.',
      ].join(' '),
    },
    {
      role: 'user',
      content: text,
    },
  ];
}

function parseJsonResponse(content) {
  const text = stripJsonCodeFence(String(content || '').trim());
  if (!text) {
    throw new GroqValidationError('Groq response was empty.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GroqValidationError('Groq response was not valid JSON.');
  }
}

function stripJsonCodeFence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return action === 'command' || action === 'draft' || action === 'chat' ? action : null;
}

function normalizeCommand(value) {
  const command = String(value || '').trim().toLowerCase();
  return GROQ_ALLOWED_COMMANDS.has(command) ? command : null;
}

function detectCommandKey(text) {
  for (const [command, pattern] of COMMAND_HINTS) {
    if (pattern.test(text)) {
      return command;
    }
  }

  return null;
}

function normalizeOutputText(value, maxChars) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }

  return truncateText(text, clampPositiveInteger(maxChars, GROQ_MAX_INPUT_CHARS));
}

function normalizeInput(value, maxChars) {
  return truncateText(String(value || '').trim().replace(/\s+/g, ' '), clampPositiveInteger(maxChars, GROQ_MAX_INPUT_CHARS));
}

function containsSensitiveContent(text) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function clampPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function truncateText(text, limit) {
  const stringValue = String(text || '');
  const max = clampPositiveInteger(limit, GROQ_MAX_INPUT_CHARS);
  return stringValue.length > max ? stringValue.slice(0, max) : stringValue;
}

function disabledClient() {
  return {
    enabled: false,
    async classifyMessage() {
      throw new GroqUnavailableError();
    },
    async generateChatReply() {
      throw new GroqUnavailableError();
    },
  };
}
