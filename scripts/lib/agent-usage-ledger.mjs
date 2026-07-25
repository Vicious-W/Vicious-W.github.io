#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(2);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

function totals(records) {
  return records.reduce(
    (sum, record) => {
      const usage = record.usage ?? {};
      sum.runs += 1;
      sum.turns += finite(usage.turns);
      sum.totalCostUsd += finite(usage.totalCostUsd);
      sum.inputTokens += finite(usage.inputTokens);
      sum.cachedInputTokens += finite(usage.cachedInputTokens);
      sum.cacheCreationInputTokens += finite(usage.cacheCreationInputTokens);
      sum.outputTokens += finite(usage.outputTokens);
      return sum;
    },
    {
      runs: 0,
      turns: 0,
      totalCostUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    },
  );
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

const [command, ledgerFile, ...args] = process.argv.slice(2);
if (!['init', 'add', 'sync', 'summary'].includes(command) || !ledgerFile) {
  fail(
    'Usage: agent-usage-ledger.mjs <init|add|sync|summary> <ledger-file> [arguments]',
  );
}

if (command === 'init') {
  const [taskId, startedAt] = args;
  if (!taskId || !startedAt) fail('init requires task ID and start timestamp.');
  writeAtomic(ledgerFile, {
    schemaVersion: 1,
    taskId,
    startedAt,
    updatedAt: startedAt,
    records: [],
    totals: totals([]),
  });
  process.exit(0);
}

const ledger = readJson(ledgerFile);
if (!ledger || !Array.isArray(ledger.records)) {
  fail(`Usage ledger is missing or invalid: ${ledgerFile}`);
}

if (command === 'add') {
  const [usageFile, stage, attempt, reason, recordedAt] = args;
  if (!usageFile || !stage || !attempt || !reason || !recordedAt) {
    fail('add requires usage file, stage, attempt, reason and timestamp.');
  }
  const usage = readJson(usageFile);
  if (!usage) fail(`Usage summary is missing or invalid: ${usageFile}`);
  const duplicate = ledger.records.some(
    (record) =>
      record.usageFile === usageFile &&
      String(record.attempt) === String(attempt) &&
      record.stage === stage,
  );
  if (!duplicate) {
    ledger.records.push({
      usageFile,
      stage,
      attempt: Number(attempt),
      reason,
      recordedAt,
      usage,
    });
  }
  ledger.updatedAt = recordedAt;
  ledger.totals = totals(ledger.records);
  writeAtomic(ledgerFile, ledger);
}

if (command === 'sync') {
  const [runDir, rootDir, recordedAt] = args;
  if (!runDir || !rootDir || !recordedAt) {
    fail('sync requires run directory, repository root and timestamp.');
  }
  const manifests = fs.existsSync(runDir)
    ? fs
        .readdirSync(runDir)
        .filter((name) => name.endsWith('.env'))
        .map((name) => path.join(runDir, name))
    : [];
  for (const manifestFile of manifests) {
    const values = Object.fromEntries(
      fs
        .readFileSync(manifestFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    if (
      values.TASK_ID !== ledger.taskId ||
      !values.STARTED_AT_UTC ||
      values.STARTED_AT_UTC < ledger.startedAt ||
      !values.USAGE_FILE
    ) {
      continue;
    }
    const usageFile = path.isAbsolute(values.USAGE_FILE)
      ? values.USAGE_FILE
      : path.join(rootDir, values.USAGE_FILE);
    const usage = readJson(usageFile);
    if (!usage) continue;
    if (ledger.records.some((record) => record.usageFile === usageFile)) continue;
    ledger.records.push({
      usageFile,
      stage: values.ROLE ?? 'UNKNOWN',
      attempt: Number(values.ROUND ?? 0),
      reason: values.STOP_REASON || values.STATUS || 'RECORDED',
      recordedAt: values.FINISHED_AT_UTC || recordedAt,
      runId: values.RUN_ID ?? null,
      model: values.MODEL ?? null,
      effort: values.EFFORT ?? null,
      usage,
    });
  }
  ledger.updatedAt = recordedAt;
  ledger.totals = totals(ledger.records);
  writeAtomic(ledgerFile, ledger);
}

if (command === 'summary') {
  process.stdout.write(`${JSON.stringify(ledger.totals)}\n`);
}
