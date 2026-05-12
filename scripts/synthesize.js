#!/usr/bin/env node

// ============================================================================
// Follow Builders — Synthesize (Claude middle step)
// ============================================================================
// Reads the JSON output of prepare-digest.js from stdin, runs Claude on it,
// and writes the synthesized digest text to stdout (where deliver.js picks
// it up).
//
// Two modes:
//   --mode=news       Full daily digest (X + podcasts + blogs)
//                     Uses summarize-* prompts + digest-intro
//   --mode=comment-x  Coffee-with-senior-peer commentary on X posts only
//                     Uses comment-tweets prompt
//
// Usage:
//   cat digest-input.json | node synthesize.js --mode=news
//   node prepare-digest.js | node synthesize.js --mode=comment-x | node deliver.js --dm
//
// Auth: shells out to the local `claude` CLI (Claude Code), which is already
// logged in. No ANTHROPIC_API_KEY required.
// ============================================================================

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_BIN = '/opt/homebrew/bin/claude';
const USER_DIR = join(homedir(), '.follow-builders');

// -- Read stdin --------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Local prompt loading (fallback path) ------------------------------------
// prepare-digest.js usually populates `data.prompts`, but if the user runs
// synthesize.js directly without that input, fall back to local prompts.

async function loadLocalPrompt(filename) {
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPath = join(scriptDir, '..', 'prompts', filename);
  if (existsSync(localPath)) return await readFile(localPath, 'utf-8');
  return null;
}

// -- Prompt builders ---------------------------------------------------------

function buildNewsPrompt(data) {
  const { prompts, podcasts, x, blogs, stats, config } = data;
  const language = config?.language || 'en';

  const parts = [
    prompts?.digest_intro || '',
    '',
    '## Podcast summary instructions',
    prompts?.summarize_podcast || '',
    '',
    '## Tweet summary instructions',
    prompts?.summarize_tweets || '',
    '',
    '## Blog summary instructions',
    prompts?.summarize_blogs || ''
  ];
  if (language === 'bilingual' || language === 'zh') {
    parts.push('', '## Translation / bilingual output instructions', prompts?.translate || '');
  }
  const systemPrompt = parts.join('\n');

  const langInstruction = ({
    en: 'Output the digest in English only.',
    zh: 'Output the digest entirely in Mandarin Chinese, following the translation instructions.',
    bilingual: 'Output the digest in BILINGUAL format. For each builder / podcast / blog post: write the English summary first, leave a blank line, then write the Chinese translation directly below it, then move to the next item. Do NOT output all English first and all Chinese after. Follow the translation instructions for tone, technical-term handling, and formatting.'
  })[language] || 'Output the digest in English only.';

  const userMessage = [
    `Generate the daily AI Builders digest.`,
    ``,
    `Date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
    `Counts: ${stats.podcastEpisodes} podcast episodes, ${stats.xBuilders} X builders (${stats.totalTweets} tweets), ${stats.blogPosts} blog posts.`,
    `Language mode: ${language}. ${langInstruction}`,
    ``,
    `Output format: a single message body, no markdown headers, sections separated by a line containing only ━━━ (three or more box-drawing horizontal lines). First line should be the digest title.`,
    ``,
    `## Podcasts feed`,
    JSON.stringify(podcasts, null, 2),
    ``,
    `## X feed`,
    JSON.stringify(x, null, 2),
    ``,
    `## Blogs feed`,
    JSON.stringify(blogs, null, 2)
  ].join('\n');

  return { systemPrompt, userMessage };
}

async function buildReplyXPrompt(data) {
  const { x } = data;

  const replyPrompt = await loadLocalPrompt('reply-tweets.md');
  if (!replyPrompt) {
    throw new Error('Could not load prompts/reply-tweets.md');
  }

  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  const userMessage = [
    `Write Leon's X reply drafts for ${dateStr} (America/Toronto).`,
    ``,
    `Source data — X posts from the last 24h, grouped by author:`,
    JSON.stringify(x, null, 2),
    ``,
    `Follow the system instructions exactly. Output only the reply digest body in English — first line must be "X Replies — ${dateStr} (America/Toronto)".`,
    `If the X feed is empty, output exactly: "No X posts captured today (feed-x.json is empty)."`
  ].join('\n');

  return { systemPrompt: replyPrompt, userMessage };
}

async function buildCommentXPrompt(data) {
  const { x } = data;

  // comment-tweets.md is NOT in prepare-digest.js's PROMPT_FILES list, so we
  // load it locally. If a remote/user override is desired later, add it there.
  const commentPrompt = await loadLocalPrompt('comment-tweets.md');
  if (!commentPrompt) {
    throw new Error('Could not load prompts/comment-tweets.md');
  }

  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  const userMessage = [
    `Write the daily X commentary for Leon (date: ${dateStr}, America/Toronto timezone).`,
    ``,
    `Source data — X posts from the last 24h, grouped by author:`,
    JSON.stringify(x, null, 2),
    ``,
    `Follow the system instructions exactly. Output only the commentary message body in English — first line must be "Daily X Commentary — ${dateStr} (America/Toronto)".`,
    `If the X feed is empty, output exactly: "No X posts captured today (feed-x.json is empty)."`
  ].join('\n');

  return { systemPrompt: commentPrompt, userMessage };
}

// -- Claude CLI invocation ---------------------------------------------------

function runClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      '--print',
      '--append-system-prompt', systemPrompt
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout.trimEnd());
      }
    });

    proc.stdin.write(userMessage);
    proc.stdin.end();
  });
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'news';

  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('synthesize.js: empty stdin\n');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`synthesize.js: invalid JSON on stdin (${err.message})\n`);
    process.exit(1);
  }

  if (data.status === 'error') {
    process.stderr.write(`synthesize.js: prepare-digest returned error: ${data.message}\n`);
    process.exit(1);
  }

  let plan;
  if (mode === 'news') {
    plan = buildNewsPrompt(data);
  } else if (mode === 'comment-x') {
    plan = await buildCommentXPrompt(data);
  } else if (mode === 'reply-x') {
    plan = await buildReplyXPrompt(data);
  } else {
    process.stderr.write(`synthesize.js: unknown mode "${mode}" (use news / comment-x / reply-x)\n`);
    process.exit(1);
  }

  const text = await runClaude(plan.systemPrompt, plan.userMessage);
  process.stdout.write(text);
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`synthesize.js error: ${err.message}\n`);
  process.exit(1);
});
