'use strict';

// PRIVATE TOOLING — not shipped in the public installer.
//
// Issues FlowStudio public-edition license keys (Door B):
//   node tools/make_license_key.js --plan Pro --exp 2027-01-31
//   node tools/make_license_key.js --plan Pro --days 365 --trial
//   node tools/make_license_key.js --init        (one-time keypair)
//
// The Ed25519 PRIVATE key never lives in this repo. It is read from
//   $FS_LICENSE_PRIVATE_KEY
// or, by default,
//   ~/workspace/license-keys/flowstudio-license-private.pem
// --init creates a fresh keypair, writes the private key to that
// path (refusing to overwrite an existing one), and prints the
// PUBLIC key PEM — embed that PEM in engine/licenseKey.js.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function privateKeyPath() {
  if (process.env.FS_LICENSE_PRIVATE_KEY) return process.env.FS_LICENSE_PRIVATE_KEY;
  return path.join(os.homedir(), 'workspace', 'license-keys', 'flowstudio-license-private.pem');
}

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function initKeypair() {
  const dest = privateKeyPath();
  if (fs.existsSync(dest)) {
    console.error(`REFUSING: ${dest} already exists — a live private key is never overwritten.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Private key written to: ${dest}`);
  console.log('Embed this PUBLIC key in engine/licenseKey.js:');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
}

function issueKey(args) {
  const dest = privateKeyPath();
  if (!fs.existsSync(dest)) {
    console.error(`Private key not found at ${dest} — run with --init first (on the issuing machine).`);
    process.exit(1);
  }
  const plan = argValue(args, '--plan');
  if (!plan) {
    console.error('Missing --plan (e.g. --plan Pro).');
    process.exit(1);
  }
  let exp = argValue(args, '--exp');
  const days = argValue(args, '--days');
  if (!exp && days) {
    const d = new Date(Date.now() + parseInt(days, 10) * 86400000);
    exp = d.toISOString().slice(0, 10);
  }
  if (!exp) {
    console.error('Missing --exp YYYY-MM-DD (or --days N). Every key must carry an expiry.');
    process.exit(1);
  }
  const kid = argValue(args, '--kid') || `key-${crypto.randomBytes(4).toString('hex')}`;
  const payload = { kid, plan, exp };
  if (args.includes('--trial')) payload.trial = true;
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(dest, 'utf8'));
  const signature = crypto.sign(null, Buffer.from(payloadSegment, 'utf8'), privateKey);
  const key = `${payloadSegment}.${signature.toString('base64url')}`;
  console.log(key);
}

const args = process.argv.slice(2);
if (args.includes('--init')) {
  initKeypair();
} else {
  issueKey(args);
}
