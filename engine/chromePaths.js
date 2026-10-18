const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Chrome location helpers (adapted from V2 profileDetector.js, minus its
 * duplicate profile scanner — profile listing for import lives in
 * accountStore.getInstalledChromeProfiles, driven by Local State).
 */

function getChromeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Google', 'Chrome', 'User Data');
}

function getChromeExecutablePath(customPath = '') {
  if (customPath && typeof customPath === 'string' && fs.existsSync(customPath)) {
    return customPath;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // Non-Windows fallbacks (development / CI only)
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

module.exports = { getChromeUserDataDir, getChromeExecutablePath };
