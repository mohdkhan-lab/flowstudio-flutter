'use strict';

// PUBLIC v1.0.0 — one-device binding fingerprint.
//
// fingerprint = SHA-256 hex of (Windows MachineGuid + machine name).
// The MachineGuid is read from the registry
// (HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid); it survives
// app reinstalls and is the standard per-machine identity on
// Windows. Only the hash is ever stored or sent — never the raw
// Guid or machine name.

const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

// Pure: the same inputs always produce the same fingerprint.
// Returns '' when both inputs are empty (no identity available).
function computeFingerprint(machineGuid, machineName) {
  const guid = String(machineGuid || '').trim().toLowerCase();
  const name = String(machineName || '').trim().toLowerCase();
  if (!guid && !name) return '';
  return crypto.createHash('sha256').update(`${guid}|${name}`, 'utf8').digest('hex');
}

// Windows-only registry read; null on any other platform or on any
// failure (a locked-down PC must not crash the gate).
function readMachineGuid() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const match = String(out).match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function getMachineFingerprint() {
  return computeFingerprint(readMachineGuid(), os.hostname());
}

module.exports = {
  computeFingerprint,
  readMachineGuid,
  getMachineFingerprint
};
