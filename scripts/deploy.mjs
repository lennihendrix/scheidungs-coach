#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const versionFile = 'docs/version.json';
const current = JSON.parse(readFileSync(versionFile, 'utf8')).version;
const [major, minor, patch] = current.split('.').map(Number);
const next = `${major}.${minor}.${patch + 1}`;

writeFileSync(versionFile, `{ "version": "${next}" }\n`);
console.log(`🔖 Version bumped: ${current} → ${next}`);

execSync(`git add docs/`, { stdio: 'inherit' });
execSync(`git commit -m "v${next}"`, { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });
