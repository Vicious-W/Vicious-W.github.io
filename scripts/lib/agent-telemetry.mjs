#!/usr/bin/env node

import fs from 'node:fs';

function usage() {
  console.error(
    'Usage: agent-telemetry.mjs <final|summary|session> <claude|codex> <events-file> [output-file]',
  );
}

function readEvents(path, executor) {
  const raw = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').trim() : '';
  if (!raw) return [];

  if (executor === 'claude') {
    try {
      return [JSON.parse(raw)];
    } catch {
      return raw
        .split(/\r?\n/)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  }

  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function claudeData(events) {
  const result = [...events].reverse().find((event) => event?.type === 'result') ?? events.at(-1) ?? {};
  const usage = result.usage ?? {};
  return {
    finalText: typeof result.result === 'string' ? result.result : '',
    sessionId: result.session_id ?? '',
    summary: {
      schemaVersion: 1,
      executor: 'claude',
      telemetryAvailable: events.length > 0,
      sessionId: result.session_id ?? null,
      turns: number(result.num_turns),
      durationMs: number(result.duration_ms),
      apiDurationMs: number(result.duration_api_ms),
      totalCostUsd: number(result.total_cost_usd),
      inputTokens: firstNumber(usage.input_tokens, usage.inputTokens),
      cachedInputTokens: firstNumber(
        usage.cache_read_input_tokens,
        usage.cached_input_tokens,
        usage.cachedInputTokens,
      ),
      cacheCreationInputTokens: firstNumber(
        usage.cache_creation_input_tokens,
        usage.cacheCreationInputTokens,
      ),
      outputTokens: firstNumber(usage.output_tokens, usage.outputTokens),
    },
  };
}

function codexData(events) {
  const threadEvent = events.find(
    (event) => event?.type === 'thread.started' || event?.type === 'thread_started',
  );
  const completed = [...events]
    .reverse()
    .find((event) => event?.type === 'turn.completed' || event?.type === 'turn_completed');
  const usage = completed?.usage ?? completed?.turn?.usage ?? {};
  const finalItem = [...events]
    .reverse()
    .find(
      (event) =>
        event?.type === 'item.completed' &&
        event?.item?.type === 'agent_message' &&
        typeof event?.item?.text === 'string',
    );
  return {
    finalText: finalItem?.item?.text ?? '',
    sessionId: threadEvent?.thread_id ?? threadEvent?.threadId ?? '',
    summary: {
      schemaVersion: 1,
      executor: 'codex',
      telemetryAvailable: events.length > 0,
      sessionId: threadEvent?.thread_id ?? threadEvent?.threadId ?? null,
      turns: number(completed?.turn_count),
      durationMs: number(completed?.duration_ms),
      apiDurationMs: null,
      totalCostUsd: null,
      inputTokens: firstNumber(usage.input_tokens, usage.inputTokens),
      cachedInputTokens: firstNumber(
        usage.cached_input_tokens,
        usage.cachedInputTokens,
      ),
      cacheCreationInputTokens: null,
      outputTokens: firstNumber(usage.output_tokens, usage.outputTokens),
    },
  };
}

const [command, executor, eventsPath, outputPath] = process.argv.slice(2);
if (
  !['final', 'summary', 'session'].includes(command) ||
  !['claude', 'codex'].includes(executor) ||
  !eventsPath
) {
  usage();
  process.exit(2);
}

const data =
  executor === 'claude'
    ? claudeData(readEvents(eventsPath, executor))
    : codexData(readEvents(eventsPath, executor));

let output = '';
if (command === 'final') output = data.finalText;
if (command === 'session') output = data.sessionId;
if (command === 'summary') output = `${JSON.stringify(data.summary, null, 2)}\n`;

if (outputPath) {
  fs.writeFileSync(outputPath, output);
} else {
  process.stdout.write(output);
  if (command === 'session' && output) process.stdout.write('\n');
}
