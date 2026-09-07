#!/usr/bin/env node
/* A stand-in for a speech model on the host: takes the recording as a file, answers JSON on stdout. */
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.find((a) => fs.existsSync(a));
const language = args[args.indexOf('--language') + 1] || 'en';
if (!file) { process.stderr.write('no recording file\n'); process.exit(2); }
const bytes = fs.statSync(file).size;
if (process.env.FAKE_TRANSCRIBER_FAIL) { process.stderr.write('model not loaded\n'); process.exit(3); }
process.stdout.write(JSON.stringify({
  text: 'Port control this is Falcon Trader requesting permission to shift to berth CT1-3', language, duration: 48,
  segments: [{ start: 0, end: 21.5, text: 'Port control this is Falcon Trader', avg_logprob: -0.15 }, { start: 21.5, end: 48, text: 'requesting permission to shift to berth CT1-3', avg_logprob: -0.25 }],
  bytes,
}));
