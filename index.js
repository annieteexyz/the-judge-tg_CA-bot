import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { PonsMCPClient, CHAIN } from '@ponsmcp/sdk';
import { settleX402, encodePaymentHeader } from '@ponsmcp/sdk';

// Load the bot's settings, then the existing wallet settings.
// Never print or log the private key.
dotenv.config();
dotenv.config({
  path: '/home/codespace/.ponsmcp.env',
  override: false
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const sentinelBaseUrl =
  process.env.SENTINEL_BASE_URL ||
  'https://api.a2a.family/a/sentinel/v1/scan_contract';

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in project .env');
  process.exit(1);
}

if (!process.env.PONSMCP_PRIVATE_KEY) {
  console.error('Wallet key was not loaded. Bot will not start.');
  process.exit(1);
}

// SDK policy values are USDG micro-units, not decimal USD strings.
// 20,000 micro-units = 0.02 USDG.
const client = new PonsMCPClient({
  privateKey: process.env.PONSMCP_PRIVATE_KEY,
  policy: {
    maxPerTx: 20_000n,
    dailyLimit: 20_000n
  }
});

const bot = new Telegraf(token);
const pendingScans = new Map();
const USDG = CHAIN.usdg.toLowerCase();
const EXPECTED_PAY_TO = '0x0a64498810C29C3Ac3b9557940b70A095dc745D9'.toLowerCase();
const MAX_PENDING_MS = 5 * 60 * 1000;

function isContractAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function pendingKey(ctx) {
  return `${ctx.chat.id}:${ctx.from.id}`;
}

function responseText(body) {
  if (body === null || body === undefined) return 'No response body.';
  const text = typeof body === 'string'
    ? body
    : JSON.stringify(body, null, 2);
  return text.length > 3000 ? `${text.slice(0, 3000)}\n…(truncated)` : text;
}

bot.start((ctx) => ctx.reply(
  '⚖️ CA Judge Bot\n\n' +
  'Use /judge followed by an EVM contract address.\n' +
  'Example: /judge 0x0000000000000000000000000000000000000000\n\n' +
  'A paid scan requires a separate /confirm command.'
));

bot.command('judge', async (ctx) => {
  const address = ctx.message.text.split(/\s+/).slice(1)[0]?.trim();

  if (!address || !isContractAddress(address)) {
    return ctx.reply(
      'Provide a valid 0x address with 40 hexadecimal characters.\n' +
      'Usage: /judge 0x0000000000000000000000000000000000000000'
    );
  }

  await ctx.reply(`🔎 Checking Sentinel requirements for:\n${address}`);

  try {
    const url = new URL(sentinelBaseUrl);
    url.searchParams.set('token', address);

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });

    const body = await response.json().catch(() => null);

    if (response.status !== 402) {
      return ctx.reply(
        `Sentinel responded with HTTP ${response.status}.\n\n` +
        'No payment was made. Response:\n' + responseText(body)
      );
    }

    const options = Array.isArray(body?.accepts) ? body.accepts : [];

    // Strictly allow only the expected exact USDG payment.
    const option = options.find((item) =>

      item.asset?.toLowerCase() === USDG &&
      String(item.maxAmountRequired) === '20000' &&
      item.payTo?.toLowerCase() === EXPECTED_PAY_TO &&
      item.resource === url.toString()
    );

    if (!option) {
      return ctx.reply(
        '🛑 No matching $0.02 exact-USDG payment option was found.\n' +
        'No payment was made.'
      );
    }

    pendingScans.set(pendingKey(ctx), {
      address,
      url: url.toString(),
      requirement: {
        ...option,
        x402Version: body.x402Version ?? 1
      },
      createdAt: Date.now()
    });

    return ctx.reply(
      '💳 Sentinel scan is ready.\n\n' +
      `Contract: ${address}\n` +
      'Payment: $0.02 USDG\n' +
      'Payment option: exact USDG only\n\n' +
      'No payment has been made yet.\n' +
      'To authorize this one scan, send /confirm within 5 minutes.'
    );
  } catch (error) {
    console.error('Sentinel pre-check failed:', error.message);
    return ctx.reply(
      '⚠️ Could not check Sentinel. No payment was made.'
    );
  }
});

bot.command('confirm', async (ctx) => {
  const key = pendingKey(ctx);
  const pending = pendingScans.get(key);

  if (!pending) {
    return ctx.reply(
      'There is no pending scan for you in this chat. Run /judge with a contract address first.'
    );
  }

  if (Date.now() - pending.createdAt > MAX_PENDING_MS) {
    pendingScans.delete(key);
    return ctx.reply('The confirmation expired. Run /judge again.');
  }

  // Remove before attempting settlement so a retry cannot double-pay.
  pendingScans.delete(key);

  await ctx.reply(
    '⏳ Attempting the approved $0.02 USDG scan. ' +
    'Please do not send another confirmation.'
  );

  try {
    const settlement = await settleX402(client, pending.requirement);

    if (!settlement.ok || !settlement.payment) {
      console.error('Settlement did not succeed:', settlement.error);
      return ctx.reply(
        '❌ Payment was not confirmed by the SDK.\n' +
        `Reason: ${settlement.error || 'Unknown settlement failure'}\n\n` +
        'No automatic retry will be attempted. Check transaction status before trying again.'
      );
    }

    const paymentHeader = encodePaymentHeader(
      pending.requirement,
      settlement.payment,
      client.address
    );

    const response = await fetch(pending.url, {
      headers: {
        Accept: 'application/json',
        'X-PAYMENT': paymentHeader
      },
      signal: AbortSignal.timeout(125000)
    });

    const text = await response.text();
    let result = text;
    try {
      result = JSON.parse(text);
    } catch {
      // Preserve non-JSON service responses as text.
    }

    if (response.status === 402) {
      return ctx.reply(
        '⚠️ Payment was reported successful, but Sentinel still requires payment.\n' +
        'Do not retry automatically. Check the transaction before taking further action.'
      );
    }

    return ctx.reply(
      `⚖️ Sentinel response for ${pending.address}\n` +
      `HTTP status: ${response.status}\n` +
      `Payment transaction: ${settlement.payment.txHash || 'not supplied'}\n\n` +
      responseText(result)
    );
  } catch (error) {
    console.error('Approved scan failed:', error.message);
    return ctx.reply(
      '⚠️ The approved scan did not complete cleanly. The payment may have been broadcast even if the response failed.\n' +
      'Do not retry until the transaction and Sentinel response have been checked.'
    );
  }
});

bot.catch((error) => {
  console.error('Telegram bot error:', error.message);
});

bot.launch()
  .then(() => console.log('CA Judge bot is running.'))
  .catch((error) => {
    console.error('Could not start bot:', error.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
