#!/usr/bin/env node

import fs from 'node:fs';

function usage() {
  console.error(
    'Usage: agent-telemetry.mjs <final|summary|live|session|outcome> <claude|codex> <events-file> [output-file]',
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
  // A resumed Claude stream may replay the previous invocation's terminal
  // result before emitting events for the new invocation. Only a result at the
  // end of the current stream is terminal for the process we are observing.
  const terminalResult =
    events.at(-1)?.type === 'result' ? events.at(-1) : null;
  const result = terminalResult ?? {};
  const terminalIndex = terminalResult ? events.length - 1 : events.length;
  let previousResultIndex = -1;
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'result') {
      previousResultIndex = index;
      break;
    }
  }
  const invocationEvents = events.slice(previousResultIndex + 1);
  const usage = result.usage ?? {};
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const lastIteration = iterations.at(-1) ?? {};
  const assistantEvents = invocationEvents.filter(
    (event) => event?.type === 'assistant' && event?.message?.usage,
  );
  const lastAssistantUsage = assistantEvents.at(-1)?.message?.usage ?? {};
  const streamTotals = assistantEvents.reduce(
    (total, event) => {
      const item = event.message.usage ?? {};
      total.inputTokens +=
        firstNumber(item.input_tokens, item.inputTokens) ?? 0;
      total.cachedInputTokens +=
        firstNumber(
          item.cache_read_input_tokens,
          item.cached_input_tokens,
          item.cachedInputTokens,
        ) ?? 0;
      total.cacheCreationInputTokens +=
        firstNumber(
          item.cache_creation_input_tokens,
          item.cacheCreationInputTokens,
        ) ?? 0;
      total.outputTokens +=
        firstNumber(item.output_tokens, item.outputTokens) ?? 0;
      return total;
    },
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    },
  );
  const modelUsage = Object.values(result.modelUsage ?? {});
  const modelTotals = modelUsage.reduce(
    (total, item) => ({
      inputTokens: total.inputTokens + (number(item?.inputTokens) ?? 0),
      cachedInputTokens:
        total.cachedInputTokens + (number(item?.cacheReadInputTokens) ?? 0),
      cacheCreationInputTokens:
        total.cacheCreationInputTokens +
        (number(item?.cacheCreationInputTokens) ?? 0),
      outputTokens: total.outputTokens + (number(item?.outputTokens) ?? 0),
      totalCostUsd: total.totalCostUsd + (number(item?.costUSD) ?? 0),
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    },
  );
  const preferPositive = (primary, fallback) =>
    Number.isFinite(primary) && primary > 0 ? primary : fallback || primary || null;
  const finalResult = terminalResult !== null;
  const lastTurnCachedInputTokens = firstNumber(
    lastIteration.cache_read_input_tokens,
    lastIteration.cached_input_tokens,
    lastIteration.cachedInputTokens,
    lastAssistantUsage.cache_read_input_tokens,
    lastAssistantUsage.cached_input_tokens,
    lastAssistantUsage.cachedInputTokens,
  );
  return {
    finalText: typeof result.result === 'string' ? result.result : '',
    sessionId:
      result.session_id ??
      [...events].reverse().find((event) => typeof event?.session_id === 'string')
        ?.session_id ??
      '',
    outcome: {
      final: finalResult,
      subtype: typeof result.subtype === 'string' ? result.subtype : null,
      isError: result.is_error === true,
      errors: Array.isArray(result.errors)
        ? result.errors.filter((item) => typeof item === 'string')
        : [],
    },
    summary: {
      schemaVersion: 1,
      executor: 'claude',
      telemetryAvailable: events.length > 0,
      final: finalResult,
      resultSubtype:
        typeof result.subtype === 'string' ? result.subtype : null,
      sessionId:
        result.session_id ??
        [...events].reverse().find((event) => typeof event?.session_id === 'string')
          ?.session_id ??
        null,
      // `num_turns` is Claude's final agentic-turn metric. Streaming assistant
      // events are a progress signal with different semantics and must never be
      // substituted for it.
      turns: finalResult ? number(result.num_turns) : null,
      reportedTurns: finalResult ? number(result.num_turns) : null,
      assistantEvents: assistantEvents.length,
      turnMetric: 'executor-final-agentic-turns',
      durationMs: number(result.duration_ms),
      apiDurationMs: number(result.duration_api_ms),
      totalCostUsd: preferPositive(result.total_cost_usd, modelTotals.totalCostUsd),
      inputTokens: preferPositive(
        firstNumber(usage.input_tokens, usage.inputTokens),
        modelTotals.inputTokens || streamTotals.inputTokens,
      ),
      cachedInputTokens: preferPositive(
        firstNumber(
          usage.cache_read_input_tokens,
          usage.cached_input_tokens,
          usage.cachedInputTokens,
        ),
        modelTotals.cachedInputTokens || streamTotals.cachedInputTokens,
      ),
      cacheCreationInputTokens: preferPositive(
        firstNumber(
          usage.cache_creation_input_tokens,
          usage.cacheCreationInputTokens,
        ),
        modelTotals.cacheCreationInputTokens ||
          streamTotals.cacheCreationInputTokens,
      ),
      outputTokens: preferPositive(
        firstNumber(usage.output_tokens, usage.outputTokens),
        modelTotals.outputTokens || streamTotals.outputTokens,
      ),
      lastTurnCachedInputTokens,
      speed: typeof usage.speed === 'string' ? usage.speed : null,
      fastModeState:
        typeof result.fast_mode_state === 'string' ? result.fast_mode_state : null,
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
      lastTurnCachedInputTokens: null,
      speed: null,
      fastModeState: null,
    },
  };
}

const [command, executor, eventsPath, outputPath] = process.argv.slice(2);
if (
  !['final', 'summary', 'live', 'session', 'outcome'].includes(command) ||
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
if (command === 'live') output = `${JSON.stringify(data.summary)}\n`;
if (command === 'outcome') {
  if (executor !== 'claude') {
    console.error('The outcome command currently supports Claude events only.');
    process.exit(2);
  }
  const { final, subtype, isError, errors } = data.outcome;
  const safeErrors = errors
    .map((item) => item.replace(/\s+/g, ' ').slice(0, 300))
    .join(' | ');
  output = `CLAUDE_RESULT final=${final} subtype=${subtype ?? 'missing'} error=${isError}${
    safeErrors ? ` details=${safeErrors}` : ''
  }\n`;
}

if (outputPath) {
  fs.writeFileSync(outputPath, output);
} else {
  process.stdout.write(output);
  if (command === 'session' && output) process.stdout.write('\n');
}

if (command === 'outcome') {
  if (!data.outcome.final) process.exit(4);
  if (
    data.outcome.subtype === 'error_max_turns' ||
    data.outcome.subtype === 'error_max_budget_usd'
  ) {
    process.exit(75);
  }
  if (data.outcome.isError || data.outcome.subtype !== 'success') process.exit(1);
}
