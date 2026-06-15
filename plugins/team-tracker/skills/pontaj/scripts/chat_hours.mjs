#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function flag(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

const cwd =
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd();
const idleMin = parseFloat(flag('idle-min', '15'));
const roundTo = parseFloat(flag('round', '0.5'));

function out(obj) {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

function slugKey(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function findDir(root, cwdPath) {
  if (!existsSync(root)) return null;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const wanted = slugKey(cwdPath);
  const match = dirs.find(
    (d) => d.isDirectory() && slugKey(d.name) === wanted,
  );
  return match ? join(root, match.name) : null;
}

function newestJsonl(paths) {
  let best = null;
  let bestM = -1;
  for (const p of paths) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = p;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

function collectClaudeTranscripts(projectDir) {
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(projectDir, f));
  } catch {
    return [];
  }
}

function collectCursorTranscripts(projectDir) {
  const agentRoot = join(projectDir, 'agent-transcripts');
  if (!existsSync(agentRoot)) return [];
  const files = [];
  const walk = (dir, inSubagents) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, inSubagents || e.name === 'subagents');
        continue;
      }
      if (e.isFile() && e.name.endsWith('.jsonl') && !inSubagents) {
        files.push(p);
      }
    }
  };
  walk(agentRoot, false);
  return files;
}

function findTranscript(cwdPath) {
  const roots = [
    { name: 'claude', root: join(homedir(), '.claude', 'projects'), collect: collectClaudeTranscripts },
    { name: 'cursor', root: join(homedir(), '.cursor', 'projects'), collect: collectCursorTranscripts },
  ];
  let best = null;
  for (const { name, root, collect } of roots) {
    const projectDir = findDir(root, cwdPath);
    if (!projectDir) continue;
    const candidates = collect(projectDir);
    const transcript = newestJsonl(candidates);
    if (!transcript) continue;
    const mtime = statSync(transcript).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { transcript, source: name, projectDir, mtime };
    }
  }
  if (!best) return null;
  return { transcript: best.transcript, source: best.source, projectDir: best.projectDir };
}

function parseLines(transcript) {
  const raw = readFileSync(transcript, 'utf8');
  return raw.split('\n').filter((l) => l.trim());
}

function lineTimestamps(lines) {
  const ts = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const candidates = [o.timestamp, o.created_at, o.createdAt, o.time].filter(Boolean);
      for (const c of candidates) {
        const t = Date.parse(c);
        if (!Number.isNaN(t)) ts.push(t);
      }
    } catch {
      /* skip */
    }
  }
  return ts;
}

function cursorTimestamps(lines, stat) {
  const birth = stat.birthtimeMs || stat.ctimeMs;
  const last = stat.mtimeMs;
  const userTurns = lines.filter((l) => l.includes('"role":"user"')).length;
  const turnEnded = lines.filter((l) => l.includes('"type":"turn_ended"')).length;
  const turns = Math.max(userTurns, turnEnded, 1);
  const rawMs = Math.max(last - birth, 0);
  const rawHours = rawMs / 3600000;
  const perTurnMin = 5;
  const estimatedActiveMs = Math.min(rawMs, turns * perTurnMin * 60 * 1000);
  return {
    ts: [birth, last],
    rawHours,
    activeHours: estimatedActiveMs / 3600000,
    turns,
    method: 'cursor_file_and_turns',
  };
}

function claudeTimestamps(ts) {
  ts.sort((a, b) => a - b);
  const first = ts[0];
  const last = ts[ts.length - 1];
  const idleMs = idleMin * 60 * 1000;
  let activeMs = 0;
  for (let i = 1; i < ts.length; i++) activeMs += Math.min(ts[i] - ts[i - 1], idleMs);
  return {
    ts,
    rawHours: (last - first) / 3600000,
    activeHours: activeMs / 3600000,
    turns: ts.length,
    method: 'claude_line_timestamps',
  };
}

function roundHours(activeHours) {
  let hours = Math.round(activeHours / roundTo) * roundTo;
  if (hours < roundTo) hours = roundTo;
  if (hours > 24) hours = 24;
  return parseFloat(hours.toFixed(2));
}

const found = findTranscript(cwd);
if (!found) {
  out({
    error: 'no transcript dir for cwd',
    cwd,
    looked: [
      join(homedir(), '.claude', 'projects'),
      join(homedir(), '.cursor', 'projects'),
    ],
    slug: slugKey(cwd),
  });
}

const { transcript, source, projectDir } = found;
const lines = parseLines(transcript);
const stat = statSync(transcript);

let result;
const lineTs = lineTimestamps(lines);
if (lineTs.length >= 2) {
  result = claudeTimestamps(lineTs);
} else if (source === 'cursor') {
  result = cursorTimestamps(lines, stat);
} else {
  out({ error: 'not enough timestamps', transcript, source, count: lineTs.length });
}

const hours = roundHours(result.activeHours);

out({
  transcript,
  source,
  project_dir: projectDir,
  method: result.method,
  first: new Date(result.ts[0]).toISOString(),
  last: new Date(result.ts[result.ts.length - 1]).toISOString(),
  num_turns: result.turns,
  raw_hours: parseFloat(result.rawHours.toFixed(2)),
  active_hours: parseFloat(result.activeHours.toFixed(2)),
  idle_clamp_min: idleMin,
  round_to: roundTo,
  hours,
});
