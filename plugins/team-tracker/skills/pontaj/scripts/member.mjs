#!/usr/bin/env node
// Remembers which team member is running on this machine, so pontaj only has to
// ask once. Stored at ~/.claude/team-tracker-member.json (per-user, per-machine).
//
//   node member.mjs get          -> prints the stored member name ("" if none)
//   node member.mjs set "Name"   -> stores the name, prints it back
//   node member.mjs path         -> prints the store file path
//
// Precedence is decided by the skill (explicit invocation > TT_MEMBER env > this
// store > ask). This script only owns the persistent store.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const STORE = join(homedir(), '.claude', 'team-tracker-member.json');

function get() {
  try {
    const obj = JSON.parse(readFileSync(STORE, 'utf8'));
    return obj && typeof obj.member === 'string' ? obj.member.trim() : '';
  } catch {
    return '';
  }
}

function set(name) {
  const member = String(name ?? '').trim();
  if (!member) {
    process.stderr.write('refuse to store an empty member name\n');
    process.exit(2);
  }
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify({ member }, null, 2) + '\n', 'utf8');
  return member;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'get':
    process.stdout.write(get());
    break;
  case 'set':
    process.stdout.write(set(rest.join(' ')));
    break;
  case 'path':
    process.stdout.write(STORE);
    break;
  default:
    process.stderr.write('usage: member.mjs get | set <name> | path\n');
    process.exit(1);
}
