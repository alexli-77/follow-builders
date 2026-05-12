#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), or stdout (default).
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "discord": sends via Discord Bot API (needs DISCORD_BOT_TOKEN + channel ID)
//   - "stdout" (default): just prints to terminal
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Discord Delivery --------------------------------------------------------

// Splits text into chunks no longer than maxLen, breaking at newlines.
function splitChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function discordPost(channelId, botToken, body) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${botToken}` },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Discord API error: ${err.message || res.statusText}`);
  }
}

// Resolves a user ID to a DM channel ID. The bot must share at least one
// server with the user. Idempotent: Discord returns the same DM channel
// every time for the same recipient.
async function openDMChannel(botToken, userId) {
  const res = await fetch(
    `https://discord.com/api/v10/users/@me/channels`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${botToken}` },
      body: JSON.stringify({ recipient_id: userId })
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Discord open-DM failed: ${err.message || res.statusText}`);
  }
  const data = await res.json();
  return data.id;
}

// Two delivery formats:
//   sendDiscordEmbeds: styled cards with color sidebar. Better-looking for
//     skimming, but text inside embeds is NOT reliably selectable on Discord
//     clients. Used for news digest in a public channel.
//   sendDiscordPlain: plain-content messages, one per ━━━ section. Fully
//     copyable on all clients. Used for personal commentary in a DM.

async function sendDiscordEmbeds(text, botToken, channelId) {
  const EMBED_COLOR = 0x5865F2; // Discord blurple
  const SECTION_SEP = /\n━+\n/;
  const DESC_MAX = 3900;

  const lines = text.trimStart().split('\n');
  const title = lines[0].trim();
  const body = lines.slice(1).join('\n').trimStart();

  const rawSections = body.split(SECTION_SEP).map(s => s.trim()).filter(Boolean);
  const sections = rawSections.flatMap(s => splitChunks(s, DESC_MAX));

  for (let i = 0; i < sections.length; i++) {
    const embed = { color: EMBED_COLOR, description: sections[i] };
    if (i === 0) embed.title = title.slice(0, 256);
    await discordPost(channelId, botToken, { embeds: [embed] });
    if (i < sections.length - 1) await new Promise(r => setTimeout(r, 600));
  }
}

async function sendDiscordPlain(text, botToken, channelId) {
  const MAX_LEN = 1900; // Discord plain-content cap is 2000; safety margin
  const SECTION_SEP = /\n━+\n/;

  const lines = text.trimStart().split('\n');
  const title = lines[0].trim();
  const body = lines.slice(1).join('\n').trimStart();

  // For each ━━━-separated author block, we emit TWO messages:
  //   1) meta: header (**Name** (@handle)) + URL lines (Post: <URL>)
  //   2) commentary: just the prose, no header, no URL
  //
  // This way the user can long-press the commentary message and copy ONLY
  // the prose — no noise from the header or links. The meta message stays
  // copyable on its own if they want the citation.
  const rawSections = body.split(SECTION_SEP).map(s => s.trim()).filter(Boolean);

  const messages = [`**${title}**`];

  for (const section of rawSections) {
    const sectionLines = section.split('\n');
    const header = sectionLines[0]; // **Name** (@handle)
    const urlLines = sectionLines.filter(l => l.trim().startsWith('Post:'));
    const commentary = sectionLines
      .slice(1)
      .filter(l => !l.trim().startsWith('Post:'))
      .join('\n')
      .trim();

    // Message A: header + URLs (the metadata, copyable as a unit)
    const metaMsg = [header, ...urlLines].filter(Boolean).join('\n');
    if (metaMsg) messages.push(metaMsg);

    // Message B: commentary alone (the prose, copyable as a unit)
    if (commentary) {
      if (commentary.length <= MAX_LEN) {
        messages.push(commentary);
      } else {
        messages.push(...splitChunks(commentary, MAX_LEN));
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    await discordPost(channelId, botToken, { content: messages[i] });
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 600));
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        await sendTelegram(digestText, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Digest sent to Telegram'
        }));
        break;
      }

      case 'discord': {
        const botToken = process.env.DISCORD_BOT_TOKEN;
        if (!botToken) throw new Error('DISCORD_BOT_TOKEN not found in .env');

        // --dm     routes to a DM with config.commentDelivery.userId
        // --plain  sends as plain content (copyable) instead of embed cards
        // The two flags are independent so any combination works.
        const dmMode = process.argv.includes('--dm');
        const plainMode = process.argv.includes('--plain');

        let targetChannelId;
        let targetLabel;
        if (dmMode) {
          const userId = config.commentDelivery?.userId;
          if (!userId) throw new Error('config.commentDelivery.userId not set (required for --dm)');
          targetChannelId = await openDMChannel(botToken, userId);
          targetLabel = `DM user ${userId}`;
        } else {
          targetChannelId = delivery.channelId;
          if (!targetChannelId) throw new Error('delivery.channelId not found in config.json');
          targetLabel = `channel ${targetChannelId}`;
        }

        if (plainMode) {
          await sendDiscordPlain(digestText, botToken, targetChannelId);
        } else {
          await sendDiscordEmbeds(digestText, botToken, targetChannelId);
        }

        console.log(JSON.stringify({
          status: 'ok',
          method: 'discord',
          format: plainMode ? 'plain' : 'embeds',
          message: `Digest sent to Discord ${targetLabel}`
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        await sendEmail(digestText, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Digest sent to ${toEmail}`
        }));
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digestText);
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

main();
