import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { ethers } from 'ethers';
import { Markup, Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const storePath = path.join(dataDir, 'orca-store.json');

const PORT = Number(process.env.PORT || 3000);
const CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID || 1952);
const RPC_URL = process.env.XLAYER_RPC_URL || 'https://testrpc.xlayer.tech/terigon';
const PRICE_POLL_INTERVAL_MS = Number(process.env.PRICE_POLL_INTERVAL_MS || 15000);
const PRICE_PAIR = process.env.PRICE_PAIR || 'OKB-USDT';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = normalizeUsername(process.env.TELEGRAM_BOT_USERNAME || '');
const BOT_URL = process.env.ORCA_BOT_URL || (BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : '');
const EXECUTION_PRIVATE_KEY = process.env.XLAYER_EXECUTION_PRIVATE_KEY || '';
const GAS_RESERVE_OKB = Number(process.env.GAS_RESERVE_OKB || '0.01');
const EXPLORER_TX_BASE_URL = process.env.XLAYER_EXPLORER_TX_URL || 'https://www.okx.com/web3/explorer/xlayer-test/tx/';
const APP_ORIGIN = (process.env.ORCA_PUBLIC_APP_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const MINI_APP_URL = process.env.ORCA_MINI_APP_URL || `${APP_ORIGIN}/wallet.html`;
const REOWN_PROJECT_ID = process.env.REOWN_PROJECT_ID || '';
const SESSION_SECRET = process.env.ORCA_SESSION_SECRET || '';
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS || 300);
const WEB_SESSION_TTL_SECONDS = Number(process.env.ORCA_WEB_SESSION_TTL_SECONDS || 1800);
const WALLET_NONCE_TTL_SECONDS = Number(process.env.ORCA_WALLET_NONCE_TTL_SECONDS || 300);
const MAX_OPEN_INTENTS_PER_USER = Number(process.env.MAX_OPEN_INTENTS_PER_USER || 3);
const IS_PRODUCTION = APP_ORIGIN.startsWith('https://');
const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Open Orca' },
  { command: 'buy', description: 'Buy the dip' },
  { command: 'sell', description: 'Sell the rally' },
  { command: 'takeprofit', description: 'Take profit' },
  { command: 'stoploss', description: 'Stop loss' },
  { command: 'dca', description: 'Dollar-cost average' },
  { command: 'new', description: 'Create a new intent' },
  { command: 'edit', description: 'Edit the current draft' },
  { command: 'list', description: 'List all intents' },
  { command: 'status', description: 'Show the latest status' },
  { command: 'wallet', description: 'Connect or manage wallet' },
  { command: 'positions', description: 'Show open positions' },
  { command: 'risk', description: 'Show wallet risk' },
  { command: 'price', description: 'Show the live OKB price' },
  { command: 'chart', description: 'Show the OKB chart' },
  { command: 'cancel', description: 'Cancel the active intent' },
  { command: 'help', description: 'Show how Orca works' },
];
const TELEGRAM_QUICK_KEYBOARD = Markup.keyboard([
  ['/buy', '/sell', '/takeprofit'],
  ['/stoploss', '/dca', '/new'],
  ['/edit', '/list', '/status'],
  ['/wallet', '/positions', '/risk'],
  ['/price', '/chart', '/cancel'],
  ['/help'],
]).resize().persistent();
const STRATEGY_TEMPLATES = {
  buy: {
    key: 'buy',
    label: 'Buy dip',
    side: 'buy',
    triggerDirection: 'below',
    template: 'Buy $10 of OKB if it drops below 95 and send it to 0xYourAddress.',
  },
  sell: {
    key: 'sell',
    label: 'Sell rally',
    side: 'sell',
    triggerDirection: 'above',
    template: 'Sell $10 of OKB if it rises above 110 and send it to 0xYourAddress.',
  },
  takeprofit: {
    key: 'takeprofit',
    label: 'Take profit',
    side: 'sell',
    triggerDirection: 'above',
    template: 'Take profit: sell $10 of OKB if it rises above 110 and send it to 0xYourAddress.',
  },
  stoploss: {
    key: 'stoploss',
    label: 'Stop loss',
    side: 'sell',
    triggerDirection: 'below',
    template: 'Stop loss: sell $10 of OKB if it drops below 85 and send it to 0xYourAddress.',
  },
  dca: {
    key: 'dca',
    label: 'DCA',
    side: 'buy',
    recurring: true,
    template: 'DCA $10 of OKB every day to 0xYourAddress for 3 times.',
  },
};
const DEFAULT_DCA_RUNS = 3;
const PRICE_CHART_CACHE_TTL_MS = 60 * 1000;
const CHART_FONT_FILES = {
  bricolage700: path.join(rootDir, 'node_modules', '@fontsource', 'bricolage-grotesque', 'files', 'bricolage-grotesque-latin-700-normal.woff2'),
  bricolage400: path.join(rootDir, 'node_modules', '@fontsource', 'bricolage-grotesque', 'files', 'bricolage-grotesque-latin-400-normal.woff2'),
  space700: path.join(rootDir, 'node_modules', '@fontsource', 'space-grotesk', 'files', 'space-grotesk-latin-700-normal.woff2'),
  space400: path.join(rootDir, 'node_modules', '@fontsource', 'space-grotesk', 'files', 'space-grotesk-latin-400-normal.woff2'),
};
const chartCache = new Map();

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const tokenFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 6,
});

const utcFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'https:', 'wss:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'", 'https://telegram.org'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(publicDir));

const miniAppRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many wallet requests. Try again shortly.' },
});

let store = await loadStore();
let priceHistory = Array.isArray(store.priceHistory) ? store.priceHistory : [];
let priceSnapshot = {
  price: null,
  source: null,
  updatedAt: null,
  pair: PRICE_PAIR,
};
let saveQueue = Promise.resolve();
let polling = false;
let bot = null;
let botReady = false;
let executionWallet = null;
const chartFonts = await loadChartFonts();

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);

if (EXECUTION_PRIVATE_KEY) {
  try {
    executionWallet = new ethers.Wallet(EXECUTION_PRIVATE_KEY, provider);
  } catch (error) {
    console.error('Invalid XLAYER_EXECUTION_PRIVATE_KEY', error);
  }
}

app.post('/api/miniapp/session', miniAppRateLimit, async (req, res) => {
  try {
    const telegramUser = verifyTelegramInitData(req.body?.initData);
    const session = createWebSession(telegramUser);
    await persistStore();

    res.cookie('orca_mini_session', session.token, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: 'strict',
      maxAge: WEB_SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      csrfToken: session.csrfToken,
      user: { id: telegramUser.id, firstName: telegramUser.first_name || 'Orca user' },
    });
  } catch (error) {
    res.status(401).json({ ok: false, error: cleanError(error) });
  }
});

app.get('/api/miniapp/config', requireMiniAppSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    projectId: REOWN_PROJECT_ID,
    appOrigin: APP_ORIGIN,
    chainId: CHAIN_ID,
    chainHex: `0x${CHAIN_ID.toString(16)}`,
    rpcUrl: RPC_URL,
    explorerUrl: EXPLORER_TX_BASE_URL.replace(/tx\/?$/, ''),
    miniAppUrl: MINI_APP_URL,
  });
});

app.get('/api/wallet', requireMiniAppSession, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, wallet: serializeWalletBinding(getWalletBinding(req.miniApp.userId)) });
});

app.post('/api/wallet/link-nonce', miniAppRateLimit, requireMiniAppSession, requireCsrf, async (req, res) => {
  try {
    const address = normalizeEvmAddress(req.body?.address);
    const requestedChainId = Number(req.body?.chainId);

    if (requestedChainId !== CHAIN_ID) {
      throw new Error(`Switch your wallet to X Layer testnet (chain ${CHAIN_ID}) first.`);
    }

    const nonce = createWalletLinkNonce(req.miniApp.userId, address);
    await persistStore();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      nonceId: nonce.id,
      message: buildWalletLinkMessage(nonce),
      expiresAt: nonce.expiresAt,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: cleanError(error) });
  }
});

app.post('/api/wallet/link-verify', miniAppRateLimit, requireMiniAppSession, requireCsrf, async (req, res) => {
  try {
    const binding = verifyWalletLink({
      userId: req.miniApp.userId,
      chatId: req.miniApp.chatId,
      nonceId: req.body?.nonceId,
      address: req.body?.address,
      signature: req.body?.signature,
    });
    await persistStore();
    notifyChat(binding.chatId, `Wallet linked to Orca.\nVerified X Layer address: ${binding.address}\nUse /buy, /sell, /takeprofit, /stoploss, or /dca to create an intent.`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, wallet: serializeWalletBinding(binding) });
  } catch (error) {
    res.status(400).json({ ok: false, error: cleanError(error) });
  }
});

app.delete('/api/wallet', miniAppRateLimit, requireMiniAppSession, requireCsrf, async (req, res) => {
  const binding = getWalletBinding(req.miniApp.userId);

  if (!binding) {
    res.status(404).json({ ok: false, error: 'No linked wallet found.' });
    return;
  }

  delete store.walletBindings[String(req.miniApp.userId)];
  pauseIntentsForWalletBinding(binding, 'Wallet disconnected by user. Link a wallet again, then create a new intent.');
  await persistStore();
  notifyChat(binding.chatId, 'Wallet disconnected from Orca. Any live intents using it have been paused.');
  res.clearCookie('orca_mini_session', { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

app.get('/api/config', (_, res) => {
  res.json({
    project: 'Orca',
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    botUrl: BOT_URL,
    botUsername: BOT_USERNAME,
    telegramReady: botReady,
    executionReady: Boolean(executionWallet),
    executionAddress: executionWallet?.address || null,
    currentPrice: priceSnapshot.price,
    currentPriceLabel: priceSnapshot.price ? usdFormatter.format(priceSnapshot.price) : null,
    priceSource: priceSnapshot.source,
    priceUpdatedAt: priceSnapshot.updatedAt,
    activeIntents: getLiveIntents().length,
    explorerTxBaseUrl: EXPLORER_TX_BASE_URL,
    miniAppReady: Boolean(REOWN_PROJECT_ID && MINI_APP_URL),
    miniAppUrl: MINI_APP_URL,
  });
});

app.get('/api/intents', (_, res) => {
  res.status(410).json({ ok: false, error: 'Intent history is available only inside the authenticated Orca Mini App.' });
});

app.get('/api/price-card', async (req, res) => {
  try {
    const days = normalizeChartDays(req.query.days);
    const snapshot = priceSnapshot.price ? priceSnapshot : await fetchLivePrice();
    const chart = await buildPriceChartCard(days, snapshot);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="okb-${days}d-chart.png"`);
    res.send(chart.buffer);
  } catch (error) {
    console.error('Failed to build price card endpoint', error);
    res.status(500).json({ ok: false, error: cleanError(error) });
  }
});

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    telegramReady: botReady,
    executionReady: Boolean(executionWallet),
    liveIntents: getLiveIntents().length,
  });
});

app.listen(PORT, () => {
  console.log(`Orca site running on http://localhost:${PORT}`);
});

await startTelegramBot();
startPriceLoop();
await pollIntentQueue();

async function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN is missing. Orca will serve the site without Telegram.');
    return;
  }

  bot = new Telegraf(BOT_TOKEN);

  await bot.telegram.setMyCommands(TELEGRAM_COMMANDS);

  if (MINI_APP_URL.startsWith('https://')) {
    try {
      await bot.telegram.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Connect wallet',
          web_app: { url: MINI_APP_URL },
        },
      });
    } catch (error) {
      console.error('Failed to configure Telegram Mini App menu button', error);
    }
  }

  bot.start(async (ctx) => {
    await ctx.reply(renderStartMessage(), TELEGRAM_QUICK_KEYBOARD);
  });

  bot.command('new', async (ctx) => {
    await resetSession(ctx);
    if (!getWalletBinding(getTelegramUserId(ctx))) {
      await ctx.reply('Connect and verify your X Layer wallet first, then send a rule like: Buy $10 of OKB if it drops below 45.', getWalletLinkKeyboard());
      return;
    }

    await ctx.reply('Send a rule like: Buy $10 of OKB if it drops below 45. Orca will use your verified linked wallet.');
  });

  bot.command('buy', async (ctx) => {
    await startTemplateFlow(ctx, 'buy');
  });

  bot.command('sell', async (ctx) => {
    await startTemplateFlow(ctx, 'sell');
  });

  bot.command('takeprofit', async (ctx) => {
    await startTemplateFlow(ctx, 'takeprofit');
  });

  bot.command('stoploss', async (ctx) => {
    await startTemplateFlow(ctx, 'stoploss');
  });

  bot.command('dca', async (ctx) => {
    await startTemplateFlow(ctx, 'dca');
  });

  bot.help(async (ctx) => {
    await ctx.reply(renderHelpMessage());
  });

  bot.command('price', async (ctx) => {
    await sendPriceCard(ctx, 1);
  });

  bot.command('chart', async (ctx) => {
    await sendPriceCard(ctx, 7);
  });

  bot.command('list', async (ctx) => {
    await ctx.reply(renderListMessage(ctx));
  });

  bot.command('edit', async (ctx) => {
    await ctx.reply(await renderEditPrompt(ctx));
  });

  bot.command('status', async (ctx) => {
    await ctx.reply(renderStatusMessage(ctx));
  });

  bot.command('wallet', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await ctx.reply('For wallet safety, open Orca in a private chat and use /wallet there.');
      return;
    }

    await ctx.reply(renderWalletMessage(ctx), getWalletLinkKeyboard());
  });

  bot.command('positions', async (ctx) => {
    await ctx.reply(renderPositionsMessage(ctx));
  });

  bot.command('risk', async (ctx) => {
    await ctx.reply(await renderRiskMessage(ctx));
  });

  bot.command('cancel', async (ctx) => {
    await cancelLatestIntent(ctx);
  });

  bot.on('text', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await ctx.reply('For wallet safety, use Orca in a private chat.');
      return;
    }

    const chatId = getChatId(ctx);
    const userId = getTelegramUserId(ctx);
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
      return;
    }

    const session = getSession(chatId);
    const binding = getWalletBinding(userId);

    if (session.step === 'awaiting_wallet_link') {
      if (!binding) {
        await ctx.reply('Connect and verify your X Layer wallet first, then send any message here to continue.', getWalletLinkKeyboard());
        return;
      }

      session.draft = applyWalletBindingToDraft(session.draft, binding);
      session.step = session.draft.triggerPrice == null && !session.draft.recurring ? 'awaiting_trigger' : 'awaiting_confirm';
      session.updatedAt = nowIso();
      await persistStore();

      if (session.step === 'awaiting_trigger') {
        await ctx.reply('What price should trigger this rule? Send just the number, like 45.');
      } else {
        await sendDraftPreview(ctx, session.draft);
      }
      return;
    }

    if (session.step === 'awaiting_trigger') {
      const triggerPrice = extractTriggerPrice(text);
      if (!triggerPrice) {
        await ctx.reply('Send just the trigger price, like 45.');
        return;
      }

      session.draft.triggerPrice = triggerPrice;
      if (binding) {
        session.draft = applyWalletBindingToDraft(session.draft, binding);
        session.step = 'awaiting_confirm';
      } else {
        session.step = 'awaiting_wallet_link';
      }
      session.updatedAt = nowIso();
      await persistStore();

      if (session.step === 'awaiting_wallet_link') {
        await ctx.reply('Connect and verify your X Layer wallet before you confirm this rule.', getWalletLinkKeyboard());
      } else {
        await sendDraftPreview(ctx, session.draft);
      }
      return;
    }

    const draft = createDraftFromText(text, binding);

    if (!draft.triggerPrice && !draft.recurring) {
      session.step = 'awaiting_trigger';
      session.draft = draft;
      session.updatedAt = nowIso();
      await persistStore();
      await ctx.reply('What price should trigger this rule? Send just the number, like 45.');
      return;
    }

    if (!binding) {
      session.step = 'awaiting_wallet_link';
      session.draft = draft;
      session.updatedAt = nowIso();
      await persistStore();
      await ctx.reply('Connect and verify your X Layer wallet before you confirm this rule.', getWalletLinkKeyboard());
      return;
    }

    session.step = 'awaiting_confirm';
    session.draft = draft;
    session.updatedAt = nowIso();
    await persistStore();
    await sendDraftPreview(ctx, draft);
  });

  bot.action('orca_new', async (ctx) => {
    await resetSession(ctx);
    await ctx.answerCbQuery('Ready');
    await ctx.reply('Send a new Orca intent whenever you are ready.');
  });

  bot.action('orca_list', async (ctx) => {
    await ctx.answerCbQuery('List');
    await ctx.reply(renderListMessage(ctx));
  });

  bot.action('orca_edit', async (ctx) => {
    await ctx.answerCbQuery('Edit');
    await ctx.reply(await renderEditPrompt(ctx));
  });

  bot.action('orca_status', async (ctx) => {
    await ctx.answerCbQuery('Status');
    await ctx.reply(renderStatusMessage(ctx));
  });

  bot.action('orca_cancel', async (ctx) => {
    await cancelLatestIntent(ctx);
    await ctx.answerCbQuery('Canceled');
  });

  bot.action('orca_confirm', async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await ctx.answerCbQuery('Private chat required');
      await ctx.reply('For wallet safety, confirm intents in a private chat with Orca.');
      return;
    }

    const chatId = getChatId(ctx);
    const userId = getTelegramUserId(ctx);
    const session = getSession(chatId);
    const draft = session.draft;
    const binding = getWalletBinding(userId);

    if (!draft) {
      await ctx.answerCbQuery('No draft');
      await ctx.reply('Send a new rule first.');
      return;
    }

    if (!binding || draft.walletBindingId !== binding.bindingId || Number(draft.walletBindingVersion) !== Number(binding.bindingVersion) || draft.recipientAddress !== binding.address) {
      session.step = 'awaiting_wallet_link';
      await persistStore();
      await ctx.answerCbQuery('Wallet link required');
      await ctx.reply('Connect and verify your current X Layer wallet before confirming this rule.', getWalletLinkKeyboard());
      return;
    }

    const openCount = getLiveIntentsForUser(userId).length;
    if (openCount >= MAX_OPEN_INTENTS_PER_USER) {
      await ctx.answerCbQuery('Open intent limit reached');
      await ctx.reply(`You already have ${openCount} live intents. Cancel one before creating another.`);
      return;
    }

    const intent = createIntentFromDraft(chatId, draft, userId);
    store.intents.push(intent);
    delete store.sessions[chatId];
    await persistStore();

    await ctx.answerCbQuery('Saved');

    const warning = executionWallet
      ? ''
      : '\n\nExecution wallet is not configured yet. Add XLAYER_EXECUTION_PRIVATE_KEY before you expect a real onchain send.';

    await ctx.reply(`${formatIntentStatus(intent)}${warning}`);
  });

  bot.catch((error, ctx) => {
    console.error('Telegram error', error);
    if (ctx?.reply) {
      ctx.reply('Orca hit a snag. Try again.');
    }
  });

  botReady = true;
  bot.launch()
    .then(() => {
      console.log('Telegram bot is running');
    })
    .catch((error) => {
      botReady = false;
      console.error('Telegram launch failed', error);
    });

  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

function startPriceLoop() {
  setInterval(() => {
    pollIntentQueue().catch((error) => {
      console.error('Price loop error', error);
    });
  }, PRICE_POLL_INTERVAL_MS);
}

async function pollIntentQueue() {
  if (polling) {
    return;
  }

  polling = true;

  try {
    priceSnapshot = await fetchLivePrice();
    await evaluateActiveIntents(priceSnapshot);
  } catch (error) {
    console.error('Failed to refresh live price', error);
  } finally {
    polling = false;
  }
}

async function evaluateActiveIntents(snapshot) {
  const now = Date.now();

  for (const intent of store.intents) {
    if (intent.status !== 'active') {
      continue;
    }

    if (!isIntentWalletBindingCurrent(intent)) {
      intent.status = 'wallet_unlinked';
      intent.lastError = 'The verified wallet was disconnected or changed before execution.';
      intent.updatedAt = nowIso();
      await persistStore();
      await notifyChat(intent.chatId, `Orca paused an intent because its linked wallet changed.\nRule: ${formatIntentRule(intent)}\nUse /wallet, then create a new intent.`);
      continue;
    }

    if (intent.expiryAt && Date.parse(intent.expiryAt) <= now) {
      intent.status = 'expired';
      intent.expiredAt = nowIso();
      intent.updatedAt = nowIso();
      await persistStore();
      await notifyChat(intent.chatId, buildExpiryMessage(intent));
      continue;
    }

    const recurringDue = isRecurringIntentDue(intent, now);
    const priceTriggered = shouldTriggerPriceIntent(intent, snapshot.price);

    if (!recurringDue && !priceTriggered) {
      continue;
    }

    if (!executionWallet) {
      if (!intent.warnedNoWallet) {
        intent.warnedNoWallet = true;
        intent.updatedAt = nowIso();
        await persistStore();
        await notifyChat(intent.chatId, buildMissingWalletMessage(intent, snapshot));
      }
      continue;
    }

    const amountWei = calculateExecutionAmount(intent.amountUsd, snapshot.price);
    const gasReserveWei = ethers.parseUnits(GAS_RESERVE_OKB.toFixed(18), 18);
    const balanceWei = await provider.getBalance(executionWallet.address);

    if (balanceWei <= amountWei + gasReserveWei) {
      if (!intent.warnedLowBalance) {
        intent.warnedLowBalance = true;
        intent.updatedAt = nowIso();
        await persistStore();
        await notifyChat(intent.chatId, buildLowBalanceMessage(intent, snapshot, amountWei, balanceWei, gasReserveWei));
      }
      continue;
    }

    await executeIntent(intent, snapshot, amountWei, { recurringRun: recurringDue });
  }
}

async function executeIntent(intent, snapshot, amountWei, options = {}) {
  const recurringRun = Boolean(options.recurringRun);
  intent.status = 'executing';
  intent.executingAt = nowIso();
  intent.updatedAt = nowIso();
  intent.attempts = (intent.attempts || 0) + 1;
  await persistStore();

  try {
    const tx = await executionWallet.sendTransaction({
      to: intent.recipientAddress,
      value: amountWei,
    });

    const receipt = await tx.wait();
    const executedAt = nowIso();

    intent.executedAt = executedAt;
    intent.lastRunAt = executedAt;
    intent.executedPrice = snapshot.price;
    intent.sentAmountWei = amountWei.toString();
    intent.sentAmountOKB = Number(ethers.formatEther(amountWei));
    intent.txHash = receipt.hash;
    intent.explorerUrl = `${EXPLORER_TX_BASE_URL}${receipt.hash}`;
    intent.blockNumber = receipt.blockNumber;
    intent.updatedAt = executedAt;

    if (recurringRun) {
      intent.runsCompleted = Number(intent.runsCompleted || 0) + 1;
      const hasMoreRuns = intent.runsTarget == null || intent.runsCompleted < intent.runsTarget;

      if (hasMoreRuns) {
        intent.status = 'active';
        intent.executingAt = null;
        intent.completedAt = null;
        intent.nextRunAt = new Date(Date.now() + (intent.intervalMs || PRICE_POLL_INTERVAL_MS)).toISOString();
        await persistStore();
        await notifyChat(intent.chatId, buildRecurringExecutionMessage(intent, snapshot));
        return;
      }

      intent.status = 'completed';
      intent.completedAt = executedAt;
      intent.nextRunAt = null;
      await persistStore();
      await notifyChat(intent.chatId, buildRecurringCompletionMessage(intent, snapshot));
      return;
    }

    intent.status = 'filled';
    intent.completedAt = executedAt;
    intent.nextRunAt = null;
    await persistStore();

    await notifyChat(intent.chatId, buildExecutionMessage(intent, snapshot));
  } catch (error) {
    intent.status = 'failed';
    intent.failedAt = nowIso();
    intent.lastError = cleanError(error);
    intent.updatedAt = nowIso();
    await persistStore();

    await notifyChat(intent.chatId, buildFailureMessage(intent, error, snapshot));
  }
}

async function fetchLivePrice() {
  const sources = [
    {
      name: 'okx',
      url: `https://www.okx.com/api/v5/market/ticker?instId=${PRICE_PAIR}`,
      parse(json) {
        return Number(json?.data?.[0]?.last);
      },
    },
    {
      name: 'coingecko',
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd',
      parse(json) {
        return Number(json?.okb?.usd);
      },
    },
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        continue;
      }

      const json = await response.json();
      const price = source.parse(json);

      if (Number.isFinite(price) && price > 0) {
        const snapshot = {
          price,
          source: source.name,
          pair: PRICE_PAIR,
          updatedAt: nowIso(),
        };

        recordPricePoint(snapshot);
        return snapshot;
      }
    } catch {
      continue;
    }
  }

  throw new Error('Unable to fetch the live OKB price.');
}

async function loadChartFonts() {
  const toDataUri = async (filePath) => {
    try {
      const bytes = await fs.readFile(filePath);
      return `data:font/woff2;base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  };

  return {
    bricolage700: await toDataUri(CHART_FONT_FILES.bricolage700),
    bricolage400: await toDataUri(CHART_FONT_FILES.bricolage400),
    space700: await toDataUri(CHART_FONT_FILES.space700),
    space400: await toDataUri(CHART_FONT_FILES.space400),
  };
}

async function sendPriceCard(ctx, days) {
  try {
    const snapshot = priceSnapshot.price ? priceSnapshot : await fetchLivePrice();
    const chart = await buildPriceChartCard(days, snapshot);
    await ctx.replyWithPhoto(
      { source: chart.buffer, filename: chart.filename },
      { caption: chart.caption }
    );
  } catch (error) {
    console.error('Failed to build price card', error);
    await ctx.reply(renderPriceMessage());
  }
}

async function buildPriceChartCard(days, snapshot) {
  const series = await fetchChartSeries(days);
  const buffer = await renderPriceChartImage(days, snapshot, series);

  return {
    buffer,
    filename: `okb-${days}d-chart.png`,
    caption: formatPriceChartCaption(days, snapshot, series),
  };
}

async function fetchChartSeries(days) {
  const cacheKey = `series:${days}:${priceHistory.length}:${priceSnapshot.updatedAt || '0'}`;
  const cached = chartCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < PRICE_CHART_CACHE_TTL_MS) {
    return cached.value;
  }

  const pointsSource = Array.isArray(priceHistory) ? priceHistory : [];
  const latestTimestamp = pointsSource.length ? pointsSource[pointsSource.length - 1].timestamp : Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const filtered = pointsSource.filter((point) => latestTimestamp - point.timestamp <= windowMs);
  const usable = sampleChartPoints(filtered.length >= 2 ? filtered : pointsSource.length >= 2 ? pointsSource : buildFallbackChartPoints(), days <= 1 ? 96 : 120);
  const prices = usable.map((point) => point.price);
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const changePct = firstPrice ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
  const spanMs = usable.length > 1 ? usable[usable.length - 1].timestamp - usable[0].timestamp : 0;

  const value = {
    days,
    points: usable,
    firstPrice,
    lastPrice,
    minPrice,
    maxPrice,
    changePct,
    spanMs,
    windowLabel: getChartWindowLabel(days, spanMs, usable.length),
    updatedAt: nowIso(),
  };

  chartCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });

  return value;
}

function buildFallbackChartPoints() {
  const price = Number(priceSnapshot.price || 0);
  const now = Date.now();
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('No price data available for chart');
  }

  return [
    { timestamp: now - 60 * 60 * 1000, price: price * 0.995 },
    { timestamp: now, price },
  ];
}

function getChartWindowLabel(days, spanMs, pointCount) {
  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = spanMs / dayMs;

  if (pointCount < 3) {
    return 'live session';
  }

  if (days === 1 && spanDays >= 0.6) {
    return '24H';
  }

  if (days === 7 && spanDays >= 4) {
    return '7D';
  }

  if (spanDays >= 1) {
    return `${spanDays.toFixed(spanDays >= 5 ? 0 : 1)}D`;
  }

  const spanHours = spanMs / (60 * 60 * 1000);
  if (spanHours >= 1) {
    return `${spanHours.toFixed(spanHours >= 5 ? 0 : 1)}H`;
  }

  return 'live session';
}

function recordPricePoint(snapshot) {
  const timestamp = Date.parse(snapshot.updatedAt || nowIso()) || Date.now();
  const price = Number(snapshot.price);

  if (!Number.isFinite(price) || price <= 0) {
    return;
  }

  const entry = {
    timestamp,
    price,
    source: snapshot.source || 'unknown',
  };

  const last = priceHistory[priceHistory.length - 1];
  if (!last || last.timestamp !== entry.timestamp || last.price !== entry.price) {
    priceHistory.push(entry);
  }

  const cutoff = timestamp - 7 * 24 * 60 * 60 * 1000;
  priceHistory = priceHistory.filter((point) => point.timestamp >= cutoff);
  store.priceHistory = priceHistory;
  chartCache.clear();
  persistStore().catch((error) => console.error('Failed to save price history', error));
}

async function renderPriceChartImage(days, snapshot, series) {
  const svg = renderPriceChartSvg(days, snapshot, series);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function renderPriceChartSvg(days, snapshot, series) {
  const currentPrice = Number(snapshot.price || series.lastPrice || 0);
  const changePct = series.changePct;
  const changeLabel = formatSignedPercent(changePct);
  const changeColor = changePct >= 0 ? '#91f1b2' : '#ff8f8f';
  const periodLabel = series.windowLabel || (days === 1 ? '24H CHART' : `${days}D CHART`);
  const sourceLabel = String(snapshot.source || 'coingecko').toUpperCase();
  const updateLabel = formatUtc(snapshot.updatedAt || series.updatedAt);
  const { linePath, areaPath, points, minPrice, maxPrice } = buildChartGeometry(series.points, {
    x: 86,
    y: 256,
    width: 1228,
    height: 430,
  });

  const chartFontCss = [
    chartFonts.bricolage700 ? `@font-face{font-family:'Orca Bricolage';src:url('${chartFonts.bricolage700}') format('woff2');font-weight:700;font-style:normal;}` : '',
    chartFonts.bricolage400 ? `@font-face{font-family:'Orca Bricolage';src:url('${chartFonts.bricolage400}') format('woff2');font-weight:400;font-style:normal;}` : '',
    chartFonts.space700 ? `@font-face{font-family:'Orca Space';src:url('${chartFonts.space700}') format('woff2');font-weight:700;font-style:normal;}` : '',
    chartFonts.space400 ? `@font-face{font-family:'Orca Space';src:url('${chartFonts.space400}') format('woff2');font-weight:400;font-style:normal;}` : '',
  ].join('');

  const gridYs = [0.2, 0.4, 0.6, 0.8].map((ratio) => 256 + 430 * ratio);
  const gridLines = gridYs.map((y) => `<line x1="86" y1="${y.toFixed(2)}" x2="1314" y2="${y.toFixed(2)}" stroke="rgba(131, 162, 200, 0.12)" stroke-width="1" />`).join('');
  const lastPoint = points[points.length - 1];
  const firstPoint = points[0];
  const captionTop = `Orca · OKB / USD · ${periodLabel}`;
  const priceText = usdFormatter.format(currentPrice);
  const highText = usdFormatter.format(series.maxPrice || currentPrice);
  const lowText = usdFormatter.format(series.minPrice || currentPrice);

  return `
  <svg width="1400" height="900" viewBox="0 0 1400 900" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1400" y2="900" gradientUnits="userSpaceOnUse">
        <stop stop-color="#041019"/>
        <stop offset="1" stop-color="#071420"/>
      </linearGradient>
      <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(280 120) rotate(15) scale(380 220)">
        <stop stop-color="#68dbff" stop-opacity="0.18"/>
        <stop offset="1" stop-color="#68dbff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="line" x1="86" y1="256" x2="1314" y2="686" gradientUnits="userSpaceOnUse">
        <stop stop-color="#68dbff"/>
        <stop offset="1" stop-color="#91f1b2"/>
      </linearGradient>
      <linearGradient id="area" x1="0" y1="256" x2="0" y2="686" gradientUnits="userSpaceOnUse">
        <stop stop-color="#68dbff" stop-opacity="0.30"/>
        <stop offset="1" stop-color="#68dbff" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="shadow" x="0" y="0" width="1400" height="900" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="24" stdDeviation="42" flood-color="#000000" flood-opacity="0.36"/>
      </filter>
      <style>
        ${chartFontCss}
        .headline { font-family: 'Orca Bricolage', 'Bricolage Grotesque', system-ui, sans-serif; font-weight: 700; }
        .body { font-family: 'Orca Space', 'Space Grotesk', system-ui, sans-serif; font-weight: 400; }
        .body-bold { font-family: 'Orca Space', 'Space Grotesk', system-ui, sans-serif; font-weight: 700; }
      </style>
    </defs>

    <rect width="1400" height="900" rx="42" fill="url(#bg)"/>
    <rect x="0" y="0" width="1400" height="900" rx="42" fill="url(#glow)"/>

    <g filter="url(#shadow)">
      <rect x="46" y="40" width="1308" height="820" rx="34" fill="rgba(10, 21, 34, 0.78)" stroke="rgba(137, 167, 202, 0.16)"/>
    </g>

    <g>
      <rect x="86" y="80" width="120" height="40" rx="20" fill="rgba(104, 219, 255, 0.12)"/>
      <text x="146" y="107" text-anchor="middle" class="body-bold" font-size="18" fill="#68dbff">ORCA</text>

      <text x="86" y="168" class="headline" font-size="66" fill="#edf6ff">${escapeXml(captionTop)}</text>
      <text x="86" y="218" class="body" font-size="24" fill="#93a6bf">Live price card from X Layer testnet trading mode</text>

      <text x="86" y="384" class="headline" font-size="96" fill="#edf6ff">${escapeXml(priceText)}</text>
      <text x="86" y="432" class="body-bold" font-size="28" fill="${changeColor}">${escapeXml(changeLabel)}</text>
      <text x="86" y="470" class="body" font-size="20" fill="#93a6bf">Source ${escapeXml(sourceLabel)} · Updated ${escapeXml(updateLabel)}</text>

      <g>
        <rect x="1040" y="92" width="220" height="72" rx="18" fill="rgba(255,255,255,0.03)" stroke="rgba(137, 167, 202, 0.12)"/>
        <text x="1060" y="124" class="body" font-size="16" fill="#93a6bf">HIGH</text>
        <text x="1060" y="154" class="headline" font-size="24" fill="#edf6ff">${escapeXml(highText)}</text>

        <rect x="1040" y="178" width="220" height="72" rx="18" fill="rgba(255,255,255,0.03)" stroke="rgba(137, 167, 202, 0.12)"/>
        <text x="1060" y="210" class="body" font-size="16" fill="#93a6bf">LOW</text>
        <text x="1060" y="240" class="headline" font-size="24" fill="#edf6ff">${escapeXml(lowText)}</text>
      </g>
    </g>

    <g>
      ${gridLines}
      <rect x="86" y="256" width="1228" height="430" rx="28" fill="rgba(255,255,255,0.02)" stroke="rgba(137, 167, 202, 0.16)"/>
      <path d="${areaPath}" fill="url(#area)"/>
      <path d="${linePath}" fill="none" stroke="url(#line)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="10" fill="#edf6ff" stroke="#68dbff" stroke-width="5"/>
    </g>

    <g>
      <text x="86" y="742" class="body" font-size="20" fill="#93a6bf">Range</text>
      <text x="86" y="776" class="headline" font-size="28" fill="#edf6ff">${escapeXml(usdFormatter.format(series.minPrice || currentPrice))} → ${escapeXml(usdFormatter.format(series.maxPrice || currentPrice))}</text>

      <text x="700" y="742" text-anchor="middle" class="body" font-size="18" fill="#93a6bf">${days === 1 ? '24H view' : '7D view'} · ${series.points.length} points</text>
      <text x="700" y="778" text-anchor="middle" class="headline" font-size="26" fill="#edf6ff">${escapeXml(formatPriceDelta(firstPoint?.price, lastPoint?.price))}</text>

      <text x="1314" y="742" text-anchor="end" class="body" font-size="20" fill="#93a6bf">Orca on X Layer testnet</text>
      <text x="1314" y="776" text-anchor="end" class="headline" font-size="28" fill="#edf6ff">Chart ready</text>
    </g>
  </svg>`;
}

function sampleChartPoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return points;
  }

  const sampled = [];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round(index * step)]);
  }

  return sampled;
}

function buildChartGeometry(points, plot) {
  const usablePoints = Array.isArray(points) ? points.filter((point) => Number.isFinite(point.price)) : [];

  if (usablePoints.length === 0) {
    throw new Error('Chart series has no usable points');
  }

  const canvasPoints = usablePoints.length === 1 ? [usablePoints[0], { ...usablePoints[0], timestamp: usablePoints[0].timestamp + 1 }] : usablePoints;
  const prices = canvasPoints.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice || 1;
  const step = canvasPoints.length > 1 ? plot.width / (canvasPoints.length - 1) : 0;
  const coords = canvasPoints.map((point, index) => {
    const x = plot.x + step * index;
    const normalized = (point.price - minPrice) / range;
    const y = plot.y + plot.height - normalized * plot.height;
    return { x, y, price: point.price };
  });

  const linePath = coords.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const bottom = plot.y + plot.height;
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${bottom.toFixed(2)} L ${coords[0].x.toFixed(2)} ${bottom.toFixed(2)} Z`;

  return { linePath, areaPath, points: coords, minPrice, maxPrice };
}

function normalizeChartDays(value) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.min(parsed, 7);
}

function formatPriceChartCaption(days, snapshot, series) {
  const periodLabel = days === 1 ? '24h' : `${days}d`;
  const currentPrice = usdFormatter.format(Number(snapshot.price || series.lastPrice || 0));
  const changeLabel = formatSignedPercent(series.changePct);
  const highLowLabel = `${usdFormatter.format(series.maxPrice || snapshot.price)} / ${usdFormatter.format(series.minPrice || snapshot.price)}`;
  const updatedLabel = formatUtc(snapshot.updatedAt || series.updatedAt);

  return [
    `OKB / USD · ${periodLabel} chart`,
    `${currentPrice} · ${changeLabel}`,
    `High/Low ${highLowLabel}`,
    `Updated ${updatedLabel}`,
  ].join('\n');
}

function formatSignedPercent(value) {
  const percent = Number(value || 0);
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

function formatPriceDelta(firstPrice, lastPrice) {
  if (!Number.isFinite(Number(firstPrice)) || !Number.isFinite(Number(lastPrice)) || Number(firstPrice) === 0) {
    return '—';
  }

  const delta = ((Number(lastPrice) - Number(firstPrice)) / Number(firstPrice)) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% since start`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    throw new Error('Telegram bot configuration is missing.');
  }

  if (typeof initData !== 'string' || !initData) {
    throw new Error('Open the wallet screen from the Orca Telegram bot.');
  }

  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));

  if (!suppliedHash || !Number.isFinite(authDate)) {
    throw new Error('Telegram sign-in data is incomplete.');
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) {
    throw new Error('Telegram sign-in expired. Close and reopen Orca from Telegram.');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expectedHash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (!safeEqualHex(suppliedHash, expectedHash)) {
    throw new Error('Telegram sign-in could not be verified.');
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || '{}');
  } catch {
    throw new Error('Telegram user data is invalid.');
  }

  if (!Number.isFinite(Number(user.id))) {
    throw new Error('Telegram user data is missing.');
  }

  return user;
}

function safeEqualHex(left, right) {
  try {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function createWebSession(telegramUser) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const record = {
    userId: String(telegramUser.id),
    chatId: String(telegramUser.id),
    csrfToken: randomBytes(24).toString('base64url'),
    createdAt: nowIso(),
    expiresAt: new Date(now + WEB_SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  store.webSessions[hashOpaqueToken(token)] = record;
  return { token, csrfToken: record.csrfToken };
}

function requireMiniAppSession(req, res, next) {
  cleanupExpiredWalletState();
  const token = parseCookies(req.headers.cookie || '').orca_mini_session;
  const session = token ? store.webSessions[hashOpaqueToken(token)] : null;

  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    res.status(401).json({ ok: false, error: 'Your wallet session expired. Reopen Orca from Telegram.' });
    return;
  }

  req.miniApp = session;
  next();
}

function requireCsrf(req, res, next) {
  const csrfToken = req.get('x-orca-csrf');

  if (!csrfToken || csrfToken !== req.miniApp?.csrfToken) {
    res.status(403).json({ ok: false, error: 'Wallet request could not be verified. Reopen Orca and try again.' });
    return;
  }

  next();
}

function parseCookies(header) {
  return header.split(';').reduce((cookies, item) => {
    const index = item.indexOf('=');
    if (index < 0) {
      return cookies;
    }

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function hashOpaqueToken(value) {
  return createHmac('sha256', SESSION_SECRET || BOT_TOKEN || 'orca-local-session').update(value).digest('hex');
}

function normalizeEvmAddress(value) {
  try {
    return ethers.getAddress(String(value || ''));
  } catch {
    throw new Error('Connect a valid EVM wallet first.');
  }
}

function createWalletLinkNonce(userId, address) {
  cleanupExpiredWalletState();
  const id = randomUUID();
  const nonce = randomBytes(24).toString('hex');
  const issuedAt = nowIso();
  const record = {
    id,
    userId: String(userId),
    address,
    chainId: CHAIN_ID,
    nonce,
    issuedAt,
    expiresAt: new Date(Date.now() + WALLET_NONCE_TTL_SECONDS * 1000).toISOString(),
  };
  store.walletLinkNonces[id] = record;
  return record;
}

function buildWalletLinkMessage(nonce) {
  return [
    'Connect your wallet to Orca',
    '',
    `Address: ${nonce.address}`,
    `Chain ID: ${nonce.chainId} (X Layer testnet)`,
    `Domain: ${APP_ORIGIN}`,
    `Nonce: ${nonce.nonce}`,
    `Issued at: ${nonce.issuedAt}`,
    `Expires at: ${nonce.expiresAt}`,
    '',
    'This signature verifies wallet ownership. It does not approve a transfer or give Orca access to your funds.',
  ].join('\n');
}

function verifyWalletLink({ userId, chatId, nonceId, address, signature }) {
  const nonce = store.walletLinkNonces[String(nonceId || '')];
  const normalizedAddress = normalizeEvmAddress(address);

  if (!nonce || nonce.userId !== String(userId) || Date.parse(nonce.expiresAt) <= Date.now()) {
    throw new Error('This wallet-link request expired. Connect again to get a new one.');
  }

  if (nonce.chainId !== CHAIN_ID || nonce.address !== normalizedAddress) {
    throw new Error('Wallet-link details do not match. Connect again and sign the new message.');
  }

  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('A wallet signature is required.');
  }

  let recovered;
  try {
    recovered = ethers.getAddress(ethers.verifyMessage(buildWalletLinkMessage(nonce), signature));
  } catch {
    throw new Error('Wallet signature could not be verified.');
  }

  if (recovered !== normalizedAddress) {
    throw new Error('The signature belongs to a different wallet.');
  }

  const anotherOwner = Object.values(store.walletBindings).find((binding) => (
    binding.address === normalizedAddress && String(binding.telegramUserId) !== String(userId)
  ));
  if (anotherOwner) {
    throw new Error('This wallet is already linked to another Orca account.');
  }

  const previous = getWalletBinding(userId);
  if (previous) {
    pauseIntentsForWalletBinding(previous, 'Wallet was replaced. Link the new wallet and recreate this intent.');
  }

  const binding = {
    bindingId: randomUUID(),
    bindingVersion: Number(previous?.bindingVersion || 0) + 1,
    telegramUserId: String(userId),
    chatId: String(chatId || userId),
    address: normalizedAddress,
    chainId: CHAIN_ID,
    verifiedAt: nowIso(),
    updatedAt: nowIso(),
    proofMessageHash: createHash('sha256').update(buildWalletLinkMessage(nonce)).digest('hex'),
  };

  store.walletBindings[String(userId)] = binding;
  delete store.walletLinkNonces[nonce.id];
  return binding;
}

function getWalletBinding(userId) {
  const binding = store.walletBindings[String(userId)];
  return binding?.chainId === CHAIN_ID ? binding : null;
}

function serializeWalletBinding(binding) {
  if (!binding) {
    return null;
  }

  return {
    address: binding.address,
    chainId: binding.chainId,
    verifiedAt: binding.verifiedAt,
    updatedAt: binding.updatedAt,
  };
}

function pauseIntentsForWalletBinding(binding, reason) {
  for (const intent of store.intents) {
    if ((intent.status === 'active' || intent.status === 'executing') && intent.walletBindingId === binding.bindingId) {
      intent.status = 'wallet_unlinked';
      intent.lastError = reason;
      intent.updatedAt = nowIso();
    }
  }
}

function isIntentWalletBindingCurrent(intent) {
  const binding = getWalletBinding(intent.ownerTelegramUserId);
  return Boolean(
    binding
      && binding.bindingId === intent.walletBindingId
      && Number(binding.bindingVersion) === Number(intent.walletBindingVersion)
      && binding.address === intent.recipientAddress
  );
}

function cleanupExpiredWalletState() {
  const now = Date.now();
  for (const [key, session] of Object.entries(store.webSessions || {})) {
    if (Date.parse(session.expiresAt) <= now) {
      delete store.webSessions[key];
    }
  }

  for (const [key, nonce] of Object.entries(store.walletLinkNonces || {})) {
    if (Date.parse(nonce.expiresAt) <= now) {
      delete store.walletLinkNonces[key];
    }
  }
}

async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const raw = await fs.readFile(storePath, 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch {
    return defaultStore();
  }
}

async function persistStore() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    cleanupExpiredWalletState();
    const trimmedHistory = Array.isArray(priceHistory) ? priceHistory.slice(-5760) : [];
    store.priceHistory = trimmedHistory;
    await fs.writeFile(storePath, JSON.stringify({ ...store, priceHistory: trimmedHistory }, null, 2), 'utf8');
  });

  return saveQueue.catch((error) => {
    console.error('Failed to save Orca store', error);
  });
}

function defaultStore() {
  return {
    version: 2,
    sessions: {},
    intents: [],
    priceHistory: [],
    walletBindings: {},
    webSessions: {},
    walletLinkNonces: {},
  };
}

function normalizeStore(raw) {
  const base = defaultStore();

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  base.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  base.walletBindings = normalizeWalletBindings(raw.walletBindings);
  base.webSessions = normalizeExpiringRecords(raw.webSessions);
  base.walletLinkNonces = normalizeExpiringRecords(raw.walletLinkNonces);
  base.intents = Array.isArray(raw.intents) ? raw.intents.map(normalizeIntent).filter(Boolean) : [];
  base.priceHistory = Array.isArray(raw.priceHistory)
    ? raw.priceHistory.map(normalizePricePoint).filter(Boolean)
    : [];

  for (const intent of base.intents) {
    if ((intent.status === 'active' || intent.status === 'executing') && !intent.walletBindingId) {
      intent.status = 'wallet_link_required';
      intent.lastError = 'This legacy intent used an unverified address. Link a wallet and create a new intent.';
      intent.updatedAt = nowIso();
    }
  }

  return base;
}

function normalizeWalletBindings(rawBindings) {
  if (!rawBindings || typeof rawBindings !== 'object') {
    return {};
  }

  return Object.entries(rawBindings).reduce((bindings, [userId, raw]) => {
    try {
      const address = normalizeEvmAddress(raw?.address);
      if (Number(raw?.chainId) !== CHAIN_ID) {
        return bindings;
      }

      bindings[String(userId)] = {
        bindingId: raw.bindingId || randomUUID(),
        bindingVersion: Number(raw.bindingVersion || 1),
        telegramUserId: String(raw.telegramUserId || userId),
        chatId: String(raw.chatId || userId),
        address,
        chainId: CHAIN_ID,
        verifiedAt: raw.verifiedAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        proofMessageHash: raw.proofMessageHash || null,
      };
    } catch {
      // Ignore malformed persisted wallet records.
    }

    return bindings;
  }, {});
}

function normalizeExpiringRecords(rawRecords) {
  if (!rawRecords || typeof rawRecords !== 'object') {
    return {};
  }

  const now = Date.now();
  return Object.entries(rawRecords).reduce((records, [key, record]) => {
    if (record && Date.parse(record.expiresAt) > now) {
      records[key] = record;
    }
    return records;
  }, {});
}

function normalizePricePoint(point) {
  if (!point || typeof point !== 'object') {
    return null;
  }

  const timestamp = Number(point.timestamp);
  const price = Number(point.price);

  if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  return {
    timestamp,
    price,
    source: point.source || 'unknown',
  };
}

function normalizeIntent(intent) {
  if (!intent || typeof intent !== 'object') {
    return null;
  }

  const strategy = resolveStrategy(intent.originalText || '', intent.strategy);
  const recurring = Boolean(intent.recurring || strategy.recurring);
  const intervalMs = recurring ? Number(intent.intervalMs || 0) || null : null;
  const runsTarget = recurring ? (intent.runsTarget == null ? null : Number(intent.runsTarget)) : 1;
  const runsCompleted = Number(intent.runsCompleted || 0);
  const triggerPrice = intent.triggerPrice == null ? null : Number(intent.triggerPrice);

  return {
    id: intent.id || randomUUID(),
    chatId: String(intent.chatId || ''),
    token: intent.token || 'OKB',
    strategy: strategy.key,
    strategyLabel: intent.strategyLabel || strategy.label,
    side: intent.side || strategy.side,
    triggerDirection: intent.triggerDirection || strategy.triggerDirection || null,
    recurring,
    amountUsd: Number(intent.amountUsd || 10),
    triggerPrice: Number.isFinite(triggerPrice) ? triggerPrice : null,
    recipientAddress: intent.recipientAddress || '',
    ownerTelegramUserId: String(intent.ownerTelegramUserId || ''),
    walletBindingId: intent.walletBindingId || null,
    walletBindingVersion: Number(intent.walletBindingVersion || 0) || null,
    recipientSource: intent.recipientSource || 'legacy_manual_unverified',
    settlementType: intent.settlementType || 'legacy_manual_transfer',
    expiryAt: intent.expiryAt || null,
    expiryLabel: intent.expiryLabel || '24 hours',
    originalText: intent.originalText || '',
    status: intent.status || 'active',
    createdAt: intent.createdAt || nowIso(),
    updatedAt: intent.updatedAt || nowIso(),
    attempts: Number(intent.attempts || 0),
    warnedNoWallet: Boolean(intent.warnedNoWallet),
    warnedLowBalance: Boolean(intent.warnedLowBalance),
    executedAt: intent.executedAt || null,
    failedAt: intent.failedAt || null,
    expiredAt: intent.expiredAt || null,
    canceledAt: intent.canceledAt || null,
    executingAt: intent.executingAt || null,
    executedPrice: intent.executedPrice || null,
    sentAmountWei: intent.sentAmountWei || null,
    sentAmountOKB: intent.sentAmountOKB || null,
    txHash: intent.txHash || null,
    explorerUrl: intent.explorerUrl || null,
    blockNumber: intent.blockNumber || null,
    lastError: intent.lastError || null,
    intervalMs,
    intervalLabel: intent.intervalLabel || (intervalMs ? formatIntervalLabel(intervalMs) : null),
    nextRunAt: intent.nextRunAt || null,
    runsTarget,
    runsCompleted,
    completedAt: intent.completedAt || null,
    lastRunAt: intent.lastRunAt || null,
  };
}

function getSession(chatId) {
  const key = String(chatId);

  if (!store.sessions[key]) {
    store.sessions[key] = {
      step: 'idle',
      draft: null,
      updatedAt: nowIso(),
    };
  }

  return store.sessions[key];
}

async function resetSession(ctx) {
  const chatId = getChatId(ctx);
  delete store.sessions[chatId];
  await persistStore();
}

function cancelLiveIntentForChat(chatId) {
  const key = String(chatId);

  for (const intent of store.intents) {
    if (intent.chatId !== key) {
      continue;
    }

    if (intent.status === 'active' || intent.status === 'executing') {
      intent.status = 'canceled';
      intent.canceledAt = nowIso();
      intent.updatedAt = nowIso();
    }
  }
}

async function cancelLatestIntent(ctx) {
  const chatId = getChatId(ctx);
  const session = getSession(chatId);
  const key = String(chatId);
  let canceled = false;

  for (let i = store.intents.length - 1; i >= 0; i -= 1) {
    const intent = store.intents[i];
    if (intent.chatId === key && (intent.status === 'active' || intent.status === 'executing')) {
      intent.status = 'canceled';
      intent.canceledAt = nowIso();
      intent.updatedAt = nowIso();
      canceled = true;
      break;
    }
  }

  session.step = 'idle';
  session.draft = null;
  session.updatedAt = nowIso();
  delete store.sessions[key];
  await persistStore();

  if (ctx.answerCbQuery) {
    await ctx.answerCbQuery(canceled ? 'Canceled' : 'Cleared');
  }

  await ctx.reply(canceled ? 'Orca canceled the active intent.' : 'Orca cleared the draft.');
}

function getLatestIntent(chatId) {
  const key = String(chatId);

  for (let i = store.intents.length - 1; i >= 0; i -= 1) {
    if (store.intents[i].chatId === key) {
      return store.intents[i];
    }
  }

  return null;
}

function getLiveIntents() {
  return store.intents.filter((intent) => intent.status === 'active' || intent.status === 'executing');
}

function getDefaultTriggerPrice(strategyKey) {
  const base = Number(priceSnapshot.price || 0);

  if (strategyKey === 'sell' || strategyKey === 'takeprofit') {
    return base ? Number((base * 1.05).toFixed(2)) : 110;
  }

  if (strategyKey === 'stoploss') {
    return base ? Number((base * 0.95).toFixed(2)) : 85;
  }

  return base ? Number((base * 0.97).toFixed(2)) : 95;
}

function createDraftFromText(text, binding = null, forcedStrategyKey = null) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const strategy = resolveStrategy(normalized, forcedStrategyKey);
  const expiry = resolveExpiry(normalized);
  const interval = strategy.recurring ? extractIntervalMs(normalized) : null;
  const triggerPrice = strategy.recurring ? null : extractTriggerPrice(normalized, strategy.triggerDirection || 'below');
  const runsTarget = strategy.recurring ? extractRunsTarget(normalized) : 1;

  return {
    token: 'OKB',
    strategy: strategy.key,
    strategyLabel: strategy.label,
    side: strategy.side,
    triggerDirection: strategy.triggerDirection || null,
    recurring: Boolean(strategy.recurring),
    amountUsd: extractAmountUsd(normalized) ?? 10,
    triggerPrice,
    recipientAddress: binding?.address || null,
    walletBindingId: binding?.bindingId || null,
    walletBindingVersion: binding?.bindingVersion || null,
    ownerTelegramUserId: binding?.telegramUserId || null,
    intervalMs: interval?.ms || null,
    intervalLabel: interval?.label || null,
    runsTarget: strategy.recurring ? (runsTarget ?? DEFAULT_DCA_RUNS) : 1,
    runsCompleted: 0,
    nextRunAt: strategy.recurring && interval?.ms ? new Date(Date.now() + interval.ms).toISOString() : null,
    expiryAt: expiry.at,
    expiryLabel: expiry.label,
    originalText: normalized,
  };
}

function createBlankDraft(strategyKey, binding = null) {
  const strategy = resolveStrategy('', strategyKey);
  const triggerPrice = strategy.recurring ? null : getDefaultTriggerPrice(strategyKey);
  const interval = strategy.recurring ? extractIntervalMs(strategy.template) || { ms: 24 * 60 * 60 * 1000, label: 'daily' } : null;
  const runsTarget = strategy.recurring ? DEFAULT_DCA_RUNS : 1;

  return {
    token: 'OKB',
    strategy: strategy.key,
    strategyLabel: strategy.label,
    side: strategy.side,
    triggerDirection: strategy.triggerDirection || null,
    recurring: Boolean(strategy.recurring),
    amountUsd: 10,
    triggerPrice,
    recipientAddress: binding?.address || null,
    walletBindingId: binding?.bindingId || null,
    walletBindingVersion: binding?.bindingVersion || null,
    ownerTelegramUserId: binding?.telegramUserId || null,
    intervalMs: interval?.ms || null,
    intervalLabel: interval?.label || null,
    runsTarget,
    runsCompleted: 0,
    nextRunAt: strategy.recurring ? new Date(Date.now() + (interval?.ms || 24 * 60 * 60 * 1000)).toISOString() : null,
    expiryAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    expiryLabel: '24 hours',
    originalText: strategy.template,
  };
}

function createIntentFromDraft(chatId, draft, ownerTelegramUserId) {
  const now = nowIso();
  const key = String(chatId);
  const strategy = resolveStrategy(draft.originalText || '', draft.strategy);
  const recurring = Boolean(draft.recurring || strategy.recurring);
  const intervalMs = recurring ? (draft.intervalMs || null) : null;
  const runsTarget = recurring ? (draft.runsTarget == null ? null : Number(draft.runsTarget)) : 1;

  return {
    id: randomUUID(),
    chatId: key,
    token: draft.token || 'OKB',
    strategy: strategy.key,
    strategyLabel: strategy.label,
    side: draft.side || strategy.side,
    triggerDirection: draft.triggerDirection || strategy.triggerDirection || null,
    recurring,
    amountUsd: Number(draft.amountUsd || 10),
    triggerPrice: draft.triggerPrice == null ? null : Number(draft.triggerPrice),
    recipientAddress: draft.recipientAddress,
    ownerTelegramUserId: String(ownerTelegramUserId || draft.ownerTelegramUserId || ''),
    walletBindingId: draft.walletBindingId || null,
    walletBindingVersion: Number(draft.walletBindingVersion || 0) || null,
    recipientSource: 'verified_wallet_binding',
    settlementType: 'sponsored_native_testnet_transfer',
    expiryAt: draft.expiryAt,
    expiryLabel: draft.expiryLabel || '24 hours',
    originalText: draft.originalText || '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    warnedNoWallet: false,
    warnedLowBalance: false,
    executedAt: null,
    failedAt: null,
    expiredAt: null,
    canceledAt: null,
    executingAt: null,
    executedPrice: null,
    sentAmountWei: null,
    sentAmountOKB: null,
    txHash: null,
    explorerUrl: null,
    blockNumber: null,
    lastError: null,
    intervalMs,
    intervalLabel: recurring ? (draft.intervalLabel || (intervalMs ? formatIntervalLabel(intervalMs) : null)) : null,
    nextRunAt: recurring ? (draft.nextRunAt || (intervalMs ? new Date(Date.now() + intervalMs).toISOString() : null)) : null,
    runsTarget,
    runsCompleted: Number.isFinite(Number(draft.runsCompleted)) ? Number(draft.runsCompleted) : 0,
    completedAt: null,
    lastRunAt: null,
  };
}

function resolveStrategy(text, forcedStrategyKey = null) {
  if (forcedStrategyKey && STRATEGY_TEMPLATES[forcedStrategyKey]) {
    return STRATEGY_TEMPLATES[forcedStrategyKey];
  }

  const lower = text.toLowerCase();

  if (/(take\s?profit|takeprofit)/i.test(lower)) {
    return STRATEGY_TEMPLATES.takeprofit;
  }

  if (/(stop\s?loss|stoploss|cut\s?loss)/i.test(lower)) {
    return STRATEGY_TEMPLATES.stoploss;
  }

  if (/\bdca\b|recurr|every\s+\d+|daily|weekly|monthly/.test(lower)) {
    return STRATEGY_TEMPLATES.dca;
  }

  if (/\bsell\b/.test(lower)) {
    return STRATEGY_TEMPLATES.sell;
  }

  return STRATEGY_TEMPLATES.buy;
}

function extractTriggerPrice(text, direction = 'below') {
  const pattern = direction === 'above'
    ? /(?:above|over|more than|higher than|rises? to|climbs? to|breaks? above|hits?|reaches?)\s+\$?(\d+(?:\.\d+)?)/i
    : /(?:below|under|less than|lower than|drops? to|falls? to|breaks? below|hits?|reaches?)\s+\$?(\d+(?:\.\d+)?)/i;
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

function extractIntervalMs(text) {
  const lower = text.toLowerCase();

  if (/(daily|every\s+day|each\s+day)/.test(lower)) {
    return { ms: 24 * 60 * 60 * 1000, label: 'daily' };
  }

  if (/(weekly|every\s+week|each\s+week)/.test(lower)) {
    return { ms: 7 * 24 * 60 * 60 * 1000, label: 'weekly' };
  }

  if (/(monthly|every\s+month|each\s+month)/.test(lower)) {
    return { ms: 30 * 24 * 60 * 60 * 1000, label: 'monthly' };
  }

  const match = lower.match(/(?:every|each|per)\s+(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  let ms = amount * 60 * 1000;

  if (unit.startsWith('hour')) {
    ms = amount * 60 * 60 * 1000;
  } else if (unit.startsWith('day')) {
    ms = amount * 24 * 60 * 60 * 1000;
  } else if (unit.startsWith('week')) {
    ms = amount * 7 * 24 * 60 * 60 * 1000;
  }

  return {
    ms,
    label: `every ${amount} ${unit}`,
  };
}

function extractRunsTarget(text) {
  const lower = text.toLowerCase();

  if (/(until canceled|until cancelled|forever|indefinite|ongoing)/.test(lower)) {
    return null;
  }

  const match = lower.match(/(?:for|x)\s*(\d+)\s*(?:times?|buys?|runs?)/) || lower.match(/(\d+)\s*times?/);
  if (!match) {
    return DEFAULT_DCA_RUNS;
  }

  return Number(match[1]);
}

function formatIntervalLabel(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (intervalMs % week === 0) {
    const count = intervalMs / week;
    return count === 1 ? 'weekly' : `every ${count} weeks`;
  }

  if (intervalMs % day === 0) {
    const count = intervalMs / day;
    return count === 1 ? 'daily' : `every ${count} days`;
  }

  if (intervalMs % hour === 0) {
    const count = intervalMs / hour;
    return count === 1 ? 'hourly' : `every ${count} hours`;
  }

  if (intervalMs % minute === 0) {
    const count = intervalMs / minute;
    return count === 1 ? 'every minute' : `every ${count} minutes`;
  }

  return `every ${intervalMs} ms`;
}

function isSimplePriceInput(text) {
  return /^\$?\d+(?:\.\d+)?$/.test(text.trim());
}

function extractAmountUsd(text) {
  const dollarMatch = text.match(/\$(\d+(?:\.\d+)?)/i);
  if (dollarMatch) {
    return Number(dollarMatch[1]);
  }

  const usdMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:usd|usdt|bucks?)\b/i);
  if (usdMatch) {
    return Number(usdMatch[1]);
  }

  return null;
}

function extractRecipientAddress(text) {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  if (!match) {
    return null;
  }

  try {
    return ethers.getAddress(match[0]);
  } catch {
    return null;
  }
}

function resolveExpiry(text) {
  const lower = text.toLowerCase();
  const relative = lower.match(/in\s+(\d+)\s*(minute|minutes|hour|hours|day|days)/i);

  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    let ms = 24 * 60 * 60 * 1000;

    if (unit.startsWith('minute')) {
      ms = amount * 60 * 1000;
    } else if (unit.startsWith('hour')) {
      ms = amount * 60 * 60 * 1000;
    } else if (unit.startsWith('day')) {
      ms = amount * 24 * 60 * 60 * 1000;
    }

    return {
      label: `in ${amount} ${unit}`,
      at: new Date(Date.now() + ms).toISOString(),
    };
  }

  if (lower.includes('tomorrow')) {
    return {
      label: 'tomorrow',
      at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  if (lower.includes('today')) {
    return {
      label: 'today',
      at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    };
  }

  return {
    label: '24 hours',
    at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function calculateExecutionAmount(amountUsd, priceUsd) {
  const nativeAmount = amountUsd / priceUsd;
  return ethers.parseUnits(nativeAmount.toFixed(18), 18);
}

async function sendDraftPreview(ctx, draft) {
  await ctx.reply(formatDraftMessage(draft), Markup.inlineKeyboard([
    [Markup.button.callback('Confirm intent', 'orca_confirm')],
    [Markup.button.callback('Edit rule', 'orca_edit'), Markup.button.callback('Start over', 'orca_new')],
    [Markup.button.callback('Cancel', 'orca_cancel')],
  ]));
}

function formatDraftMessage(draft) {
  const estimated = priceSnapshot.price
    ? `${tokenFormatter.format(draft.amountUsd / priceSnapshot.price)} OKB`
    : 'waiting for live price';

  const lines = [
    'Orca draft',
    `Rule: ${formatIntentRule(draft)}`,
    `Linked wallet: ${draft.recipientAddress ? shortAddress(draft.recipientAddress) : 'not connected'}`,
    `Expiry: ${formatUtc(draft.expiryAt)} (${draft.expiryLabel})`,
    `Estimated sponsored send: ${estimated}`,
  ];

  if (draft.recurring) {
    lines.push(`Schedule: ${draft.intervalLabel || 'daily'} · ${draft.runsTarget == null ? 'until canceled' : `${draft.runsTarget} runs`}`);
  }

  lines.push('', executionWallet
    ? 'Orca’s execution wallet will send a sponsored native OKB testnet transfer to your verified linked wallet when the trigger hits.'
    : 'The intent is live, but Orca’s execution wallet still needs to be configured.');

  return lines.join('\n');
}

function formatIntentStatus(intent) {
  const lines = [
    'Orca status',
    `State: ${intent.status}`,
    `Rule: ${formatIntentRule(intent)}`,
    `Linked wallet: ${intent.recipientAddress ? shortAddress(intent.recipientAddress) : 'not linked'}`,
    `Settlement: sponsored native OKB testnet transfer`,
    `Expiry: ${formatUtc(intent.expiryAt)} (${intent.expiryLabel})`,
  ];

  if (intent.recurring) {
    lines.push(`Progress: ${intent.runsCompleted || 0}${intent.runsTarget == null ? '' : `/${intent.runsTarget}`} runs`);
    if (intent.nextRunAt) {
      lines.push(`Next run: ${formatUtc(intent.nextRunAt)}`);
    }
  }

  lines.push(
    priceSnapshot.price ? `Live price: ${usdFormatter.format(priceSnapshot.price)} via ${priceSnapshot.source}` : null,
    intent.txHash ? `Tx hash: ${intent.txHash}` : null,
    intent.explorerUrl ? `Explorer: ${intent.explorerUrl}` : null,
    intent.executedAt ? `Executed: ${formatUtc(intent.executedAt)}` : null,
    intent.completedAt ? `Completed: ${formatUtc(intent.completedAt)}` : null,
    intent.lastError ? `Last error: ${intent.lastError}` : null,
  );

  return lines.filter(Boolean).join('\n');
}

function renderStartMessage() {
  return [
    'Welcome to Orca.',
    'First use /wallet to connect and verify your X Layer testnet wallet, then tap a strategy or send a sentence like “Buy $10 of OKB if it drops below 45.”',
    'Orca uses your verified wallet as the recipient. It never asks for your private key.',
    '',
    'Commands: /wallet /buy /sell /takeprofit /stoploss /dca /new /edit /list /status /positions /risk /price /chart /cancel /help',
  ].join('\n');
}

function renderHelpMessage() {
  return [
    'Orca turns plain English into a live X Layer testnet intent.',
    'Start with /wallet: connect an EVM wallet, switch to X Layer testnet (1952), and sign once to verify ownership.',
    'Examples: Buy $10 of OKB if it drops below 45. Sell $10 of OKB if it rises above 110. DCA $10 every day.',
    'Orca uses the verified linked wallet as your receiving address. It never receives your private key and the signature does not approve spending from your wallet.',
    'Use /buy, /sell, /takeprofit, /stoploss, or /dca to load a template. Use /price or /chart for the live OKB card, /wallet to manage your link, /list to see every stored rule, /status to see the latest live one, and /positions or /risk to inspect the testnet state.',
  ].join('\n');
}

function renderWalletMessage(ctx) {
  const binding = getWalletBinding(getTelegramUserId(ctx));

  if (!binding) {
    return [
      'No wallet is linked yet.',
      `Connect an EVM wallet, switch to X Layer testnet (chain ${CHAIN_ID}), and sign the one-time ownership message.`,
      'Your private key never leaves your wallet. The signature does not approve a transfer.',
      MINI_APP_URL.startsWith('https://') ? 'Tap Connect wallet below.' : 'Wallet Mini App needs a public HTTPS URL before it can open inside Telegram.',
    ].join('\n');
  }

  return [
    'Orca wallet',
    `Linked wallet: ${binding.address}`,
    `Network: X Layer testnet (${binding.chainId})`,
    `Verified: ${formatUtc(binding.verifiedAt)}`,
    '',
    'New intents will use this verified address as the recipient for sponsored testnet transfers.',
  ].join('\n');
}

function getWalletLinkKeyboard() {
  if (!MINI_APP_URL.startsWith('https://')) {
    return undefined;
  }

  return Markup.inlineKeyboard([
    [Markup.button.webApp('Connect wallet', MINI_APP_URL)],
  ]);
}

function applyWalletBindingToDraft(draft, binding) {
  return {
    ...draft,
    recipientAddress: binding.address,
    walletBindingId: binding.bindingId,
    walletBindingVersion: binding.bindingVersion,
    ownerTelegramUserId: binding.telegramUserId,
  };
}

function renderPriceMessage() {
  return priceSnapshot.price
    ? [
        `Live OKB price: ${usdFormatter.format(priceSnapshot.price)}`,
        `Source: ${priceSnapshot.source}`,
        `Updated: ${formatUtc(priceSnapshot.updatedAt)}`,
      ].join('\n')
    : 'Orca is still loading the live price feed.';
}

function renderStatusMessage(ctx) {
  const chatId = getChatId(ctx);
  const binding = getWalletBinding(getTelegramUserId(ctx));
  const liveIntent = getLatestLiveIntent(chatId) || getLatestIntent(chatId);

  if (liveIntent) {
    return formatIntentStatus(liveIntent);
  }

  const intents = getIntentsForChat(chatId);

  return [
    'No intent is live yet.',
    binding ? `Linked wallet: ${shortAddress(binding.address)}` : 'Linked wallet: not connected. Use /wallet.',
    renderPriceMessage(),
    executionWallet ? `Orca execution wallet: ${shortAddress(executionWallet.address)}` : 'Orca execution wallet: not configured yet',
    intents.length
      ? `You have ${intents.length} stored intent${intents.length === 1 ? '' : 's'}. Use /list, /positions, or /risk.`
      : 'Use /new to create your first rule, then /positions or /risk to inspect it.',
  ].join('\n\n');
}

function getLiveIntentsForChat(chatId) {
  return getIntentsForChat(chatId).filter((intent) => intent.status === 'active' || intent.status === 'executing');
}

function renderPositionsMessage(ctx) {
  const intents = getLiveIntentsForChat(getChatId(ctx));

  if (!intents.length) {
    return [
      'No open positions yet.',
      'Use /buy, /sell, /takeprofit, /stoploss, or /dca to open one.',
    ].join('\n');
  }

  const totalNotional = intents.reduce((sum, intent) => sum + Number(intent.amountUsd || 0), 0);
  const lines = [
    'Orca positions',
    `Open: ${intents.length} · Notional: ${usdFormatter.format(totalNotional)}`,
    '',
  ];

  intents.slice(0, 8).forEach((intent, index) => {
    lines.push(...formatPositionSummary(intent, index + 1));
  });

  if (intents.length > 8) {
    lines.push('', `Showing latest 8 of ${intents.length}.`);
  }

  lines.push('', 'Use /risk to inspect wallet headroom or /status for the latest live rule.');
  return lines.join('\n');
}

function formatPositionSummary(intent, index) {
  const state = intent.status === 'executing' ? 'EXECUTING' : 'LIVE';
  const details = [
    `${usdFormatter.format(Number(intent.amountUsd || 0))}`,
    `to ${shortAddress(intent.recipientAddress)}`,
  ];

  if (intent.recurring) {
    details.push(intent.intervalLabel || 'daily DCA');
    if (intent.runsTarget != null) {
      details.push(`${intent.runsCompleted || 0}/${intent.runsTarget} runs`);
    }
    if (intent.nextRunAt) {
      details.push(`next ${formatUtc(intent.nextRunAt)}`);
    }
  } else if (intent.triggerPrice != null) {
    details.push(`trigger ${usdFormatter.format(Number(intent.triggerPrice))}`);
  }

  if (intent.lastRunAt) {
    details.push(`last ${formatUtc(intent.lastRunAt)}`);
  }

  return [
    `${index}. [${state}] ${formatIntentRule(intent)}`,
    `   ${details.join(' · ')}`,
  ];
}

async function renderRiskMessage(ctx) {
  const binding = getWalletBinding(getTelegramUserId(ctx));
  const intents = getLiveIntentsForChat(getChatId(ctx));
  const totalNotional = intents.reduce((sum, intent) => sum + Number(intent.amountUsd || 0), 0);
  const reserveWei = ethers.parseUnits(GAS_RESERVE_OKB.toFixed(18), 18);
  const reserveLabel = `Gas reserve: ${tokenFormatter.format(GAS_RESERVE_OKB)} OKB`;

  let walletLine = 'Execution wallet: not configured yet';
  let balanceLine = 'Wallet balance: unavailable';
  let balanceWei = null;

  if (executionWallet) {
    walletLine = `Execution wallet: ${shortAddress(executionWallet.address)}`;

    try {
      balanceWei = await provider.getBalance(executionWallet.address);
      balanceLine = `Wallet balance: ${tokenFormatter.format(Number(ethers.formatEther(balanceWei)))} OKB`;
    } catch {
      balanceLine = 'Wallet balance: unavailable';
    }
  }

  const lines = [
    'Orca risk',
    binding ? `Linked wallet: ${shortAddress(binding.address)}` : 'Linked wallet: not connected',
    walletLine,
    balanceLine,
    reserveLabel,
    `Chain: ${CHAIN_ID}`,
    priceSnapshot.price ? `Live price: ${usdFormatter.format(priceSnapshot.price)} via ${priceSnapshot.source}` : 'Live price: loading',
    `Open positions: ${intents.length}`,
    `Active notional: ${usdFormatter.format(totalNotional)}`,
  ];

  if (!executionWallet) {
    lines.push('Add XLAYER_EXECUTION_PRIVATE_KEY before you expect real settlement.');
  } else if (balanceWei != null && balanceWei <= reserveWei) {
    lines.push('Wallet is at or below the gas reserve.');
  } else if (intents.length) {
    lines.push('Wallet headroom looks healthy for the current open rules.');
  } else {
    lines.push('No live positions are open yet.');
  }

  lines.push('', 'Use /positions to inspect every live rule or /list to review the full history.');
  return lines.join('\n');
}

function shortAddress(value) {
  if (!value) {
    return 'unknown';
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function getIntentsForChat(chatId) {
  const key = String(chatId);

  return store.intents
    .filter((intent) => intent.chatId === key)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function renderEditPrompt(ctx) {
  const chatId = getChatId(ctx);
  const session = getSession(chatId);
  const currentDraft = session.draft;
  const liveIntent = getLatestLiveIntent(chatId);
  const hasCurrentDraft = Boolean(currentDraft);
  const hasLiveIntent = Boolean(liveIntent);

  await resetSession(ctx);

  if (!hasCurrentDraft && !hasLiveIntent) {
    return 'No draft or live intent to edit yet. Use /new to start one.';
  }

  const lines = ['Orca edit mode'];

  if (hasCurrentDraft) {
    lines.push('Current draft:');
    lines.push(renderDraft(currentDraft));
    lines.push('', 'Send a revised sentence to rebuild it.');
  } else if (hasLiveIntent) {
    lines.push('Current live rule:');
    lines.push(formatIntentStatus(liveIntent));
    lines.push('', 'Send a revised sentence to create a new draft. The current live rule stays active until you cancel it.');
  }

  return lines.join('\n');
}

function formatIntentRule(intent) {
  const action = intent.side === 'sell' ? 'sell' : 'buy';
  const amount = usdFormatter.format(Number(intent.amountUsd || 0));
  const token = intent.token || 'OKB';

  if (intent.recurring) {
    const cadence = intent.intervalLabel === 'daily'
      ? 'every day'
      : intent.intervalLabel === 'weekly'
        ? 'every week'
        : intent.intervalLabel === 'monthly'
          ? 'every month'
          : intent.intervalLabel && intent.intervalLabel.startsWith('every ')
            ? intent.intervalLabel
            : 'daily';
    const runsText = intent.runsTarget == null
      ? ' until canceled'
      : ` for ${intent.runsTarget} run${intent.runsTarget === 1 ? '' : 's'}`;
    return `${action} ${amount} of ${token} ${cadence}${runsText}`;
  }

  const direction = intent.triggerDirection || (action === 'sell' ? 'above' : 'below');
  const trigger = Number.isFinite(Number(intent.triggerPrice))
    ? usdFormatter.format(Number(intent.triggerPrice))
    : 'a target';

  return `${action} ${amount} of ${token} if it ${direction === 'above' ? 'rises above' : 'drops below'} ${trigger}`;
}

function renderStrategyTemplate(strategyKey, draft = createBlankDraft(strategyKey)) {
  const strategy = resolveStrategy('', strategyKey);
  const lines = [
    `${strategy.label} loaded.`,
    `Rule: ${formatIntentRule(draft)}`,
  ];

  if (draft.recurring) {
    lines.push(`Schedule: ${draft.intervalLabel || 'daily'} · ${draft.runsTarget == null ? 'until canceled' : `${draft.runsTarget} runs`}`);
  } else if (draft.triggerPrice != null) {
    lines.push(`Trigger: ${draft.triggerDirection || strategy.triggerDirection || 'below'} ${usdFormatter.format(draft.triggerPrice)}`);
  }

  lines.push('', draft.recipientAddress
    ? `Verified wallet: ${shortAddress(draft.recipientAddress)}`
    : 'Connect and verify your X Layer wallet to finish this template.');
  lines.push('Use /edit if you want to tweak the numbers, or /cancel to stop.');
  return lines.join('\n');
}

async function startTemplateFlow(ctx, strategyKey) {
  if (!isPrivateChat(ctx)) {
    await ctx.reply('For wallet safety, use Orca in a private chat.');
    return;
  }

  const chatId = getChatId(ctx);
  const binding = getWalletBinding(getTelegramUserId(ctx));
  const draft = createBlankDraft(strategyKey, binding);
  const session = getSession(chatId);

  session.step = binding ? 'awaiting_confirm' : 'awaiting_wallet_link';
  session.draft = draft;
  session.updatedAt = nowIso();
  await persistStore();

  if (!binding) {
    await ctx.reply(renderStrategyTemplate(strategyKey, draft), getWalletLinkKeyboard());
    return;
  }

  await sendDraftPreview(ctx, draft);
}

function formatIntentListItem(intent) {
  const parts = [
    `[${intent.status}]`,
    formatIntentRule(intent),
  ];

  if (intent.recurring) {
    const progress = intent.runsTarget == null
      ? `${intent.runsCompleted || 0} runs`
      : `${intent.runsCompleted || 0}/${intent.runsTarget} runs`;
    parts.push(progress);
  }

  if (intent.expiryAt) {
    parts.push(`exp ${formatUtc(intent.expiryAt)}`);
  }

  if (intent.txHash) {
    parts.push(`tx ${shortHash(intent.txHash)}`);
  }

  return parts.join(' · ');
}

function renderListMessage(ctx) {
  const intents = getIntentsForChat(getChatId(ctx));

  if (!intents.length) {
    return ['No intents yet.', 'Use /new to create one.'].join('\n');
  }

  const liveCount = intents.filter((intent) => intent.status === 'active' || intent.status === 'executing').length;
  const lines = [
    'Orca intents',
    `Live: ${liveCount} · Total: ${intents.length}`,
    '',
  ];

  intents.slice(0, 8).forEach((intent, index) => {
    lines.push(`${index + 1}. ${formatIntentListItem(intent)}`);
  });

  if (intents.length > 8) {
    lines.push('', `Showing latest 8 of ${intents.length}.`);
  }

  lines.push('', 'Use /status for the latest live rule, /positions to inspect open rules, /risk to check wallet headroom, /edit to rebuild a draft, or /cancel to stop the latest live rule.');
  return lines.join('\n');
}

function shortHash(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function getLatestLiveIntent(chatId) {
  const key = String(chatId);

  for (let i = store.intents.length - 1; i >= 0; i -= 1) {
    const intent = store.intents[i];
    if (intent.chatId === key && (intent.status === 'active' || intent.status === 'executing')) {
      return intent;
    }
  }

  return null;
}

function isRecurringIntentDue(intent, now) {
  if (!intent.recurring || intent.strategy !== 'dca' || !intent.nextRunAt) {
    return false;
  }

  return Date.parse(intent.nextRunAt) <= now;
}

function shouldTriggerPriceIntent(intent, price) {
  if (!Number.isFinite(price) || intent.triggerPrice == null) {
    return false;
  }

  const direction = intent.triggerDirection || (intent.side === 'sell' ? 'above' : 'below');
  return direction === 'above' ? price >= intent.triggerPrice : price <= intent.triggerPrice;
}

function buildExecutionMessage(intent, snapshot) {
  return [
    'Orca executed on X Layer testnet.',
    `Rule: ${formatIntentRule(intent)}`,
    `Sent: ${tokenFormatter.format(Number(intent.sentAmountOKB))} OKB`,
    `Notional: ${usdFormatter.format(intent.amountUsd)}`,
    intent.triggerPrice != null ? `Trigger price: ${usdFormatter.format(intent.triggerPrice)}` : null,
    `Live price: ${usdFormatter.format(snapshot.price)}`,
    `Tx hash: ${intent.txHash}`,
    `Explorer: ${intent.explorerUrl}`,
  ].filter(Boolean).join('\n');
}

function buildRecurringExecutionMessage(intent, snapshot) {
  const runsText = intent.runsTarget == null
    ? `${intent.runsCompleted || 0} runs complete`
    : `${intent.runsCompleted || 0}/${intent.runsTarget} runs complete`;

  return [
    'Orca completed a recurring run.',
    `Rule: ${formatIntentRule(intent)}`,
    runsText,
    `Sent: ${tokenFormatter.format(Number(intent.sentAmountOKB))} OKB`,
    `Live price: ${usdFormatter.format(snapshot.price)}`,
    `Tx hash: ${intent.txHash}`,
    `Explorer: ${intent.explorerUrl}`,
    intent.nextRunAt ? `Next run: ${formatUtc(intent.nextRunAt)}` : null,
  ].filter(Boolean).join('\n');
}

function buildRecurringCompletionMessage(intent, snapshot) {
  return [
    'Orca finished the recurring schedule.',
    `Rule: ${formatIntentRule(intent)}`,
    `Runs completed: ${intent.runsCompleted || 0}`,
    `Last price: ${usdFormatter.format(snapshot.price)}`,
    `Explorer: ${intent.explorerUrl}`,
  ].join('\n');
}

function buildExpiryMessage(intent) {
  return [
    'Orca intent expired.',
    `The rule for ${formatIntentRule(intent)} expired before it could finish.`,
    `Expired: ${formatUtc(intent.expiredAt)}`,
  ].join('\n');
}

function buildMissingWalletMessage(intent, snapshot) {
  return [
    'Orca reached the trigger, but the execution wallet is not configured yet.',
    `Rule: ${formatIntentRule(intent)}`,
    `Live price: ${usdFormatter.format(snapshot.price)}`,
    intent.triggerPrice != null ? `Trigger: ${usdFormatter.format(intent.triggerPrice)}` : null,
    'Add XLAYER_EXECUTION_PRIVATE_KEY and the active intent can execute while the rule is still live.',
  ].filter(Boolean).join('\n');
}

function buildLowBalanceMessage(intent, snapshot, amountWei, balanceWei, gasReserveWei) {
  const neededWei = amountWei + gasReserveWei;
  return [
    'Orca reached the trigger, but the execution wallet needs more OKB.',
    `Rule: ${formatIntentRule(intent)}`,
    `Needed: ${ethers.formatEther(neededWei)} OKB including gas`,
    `Available: ${ethers.formatEther(balanceWei)} OKB`,
    `Live price: ${usdFormatter.format(snapshot.price)}`,
    intent.triggerPrice != null ? `Trigger: ${usdFormatter.format(intent.triggerPrice)}` : null,
  ].filter(Boolean).join('\n');
}

function buildFailureMessage(intent, error, snapshot) {
  return [
    'Orca tried to execute the intent and the transaction failed.',
    `Live price: ${usdFormatter.format(snapshot.price)}`,
    `Trigger: ${usdFormatter.format(intent.triggerPrice)}`,
    `Error: ${cleanError(error)}`,
    'The intent has been marked failed so it will not send twice.',
  ].join('\n');
}

async function notifyChat(chatId, message) {
  if (!botReady || !bot) {
    console.log(`[Orca:${chatId}] ${message}`);
    return;
  }

  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (error) {
    console.error('Failed to notify Telegram chat', error);
  }
}

function cleanError(error) {
  return error?.shortMessage || error?.reason || error?.message || 'Unknown error';
}

function formatUtc(value) {
  if (!value) {
    return 'not set';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return utcFormatter.format(parsed);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return value.replace(/^@/, '').trim();
}

function getTelegramUserId(ctx) {
  return String(ctx.from?.id ?? ctx.update?.callback_query?.from?.id ?? 'unknown');
}

function isPrivateChat(ctx) {
  const chat = ctx.chat ?? ctx.update?.callback_query?.message?.chat;
  return chat?.type === 'private';
}

function getLiveIntentsForUser(userId) {
  const key = String(userId);
  return store.intents.filter((intent) => (
    String(intent.ownerTelegramUserId) === key
      && (intent.status === 'active' || intent.status === 'executing')
  ));
}

function getChatId(ctx) {
  return String(ctx.chat?.id ?? ctx.update?.callback_query?.message?.chat?.id ?? ctx.from?.id ?? 'unknown');
}
