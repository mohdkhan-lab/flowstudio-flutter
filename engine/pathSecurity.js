const path = require('path');
const fs = require('fs');

const ALLOWED_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif'
]);

function resolveInside(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertInside(root, candidate, label = 'Path') {
  if (typeof candidate !== 'string' || !candidate.trim() || !resolveInside(root, candidate)) {
    throw new Error(`${label} is outside the allowed directory`);
  }
  return path.resolve(candidate);
}

function assertAllowedMediaFolder(folderPath, allowedRoots = [], label = 'Folder path') {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw new Error(`${label} cannot be empty`);
  }
  const resolved = path.resolve(folderPath.trim());
  const isAllowed = allowedRoots.some(root => resolveInside(root, resolved));
  if (!isAllowed) {
    throw new Error(`${label} is outside allowed media roots`);
  }
  return resolved;
}

function assertAllowedMediaFile(filePath, allowedRoots = [], allowedExts = ALLOWED_MEDIA_EXTENSIONS, label = 'Media file path') {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`${label} cannot be empty`);
  }
  const resolved = path.resolve(filePath.trim());
  const isAllowed = allowedRoots.some(root => resolveInside(root, resolved));
  if (!isAllowed) {
    throw new Error(`${label} is outside allowed media roots`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`${label} has an unauthorized file extension: "${ext}"`);
  }
  return resolved;
}

function assertAccountId(accountId) {
  if (typeof accountId !== 'string' || !/^acc_[A-Za-z0-9_-]+$/.test(accountId.trim())) {
    throw new Error('Invalid account id format');
  }
  return accountId.trim();
}

function assertChromeProfileDirName(profileDirName) {
  if (typeof profileDirName !== 'string' || !/^(Default|Profile [0-9]+)$/.test(profileDirName.trim())) {
    throw new Error('Invalid Chrome profile directory name');
  }
  return profileDirName.trim();
}

function sanitizeFilePart(value, fallback = 'scene') {
  const raw = String(value || fallback);
  const base = path.win32.basename(path.posix.basename(raw));
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

function sanitizeProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return '';
  const trimmed = proxyUrl.trim();
  // Redact password in user:password@host:port
  return trimmed.replace(/(https?:\/\/|socks5:\/\/|socks4:\/\/)?([^:/@\s]+):([^@\s]+)@/i, (m, scheme, user) => {
    return `${scheme || ''}${user}:***@`;
  });
}

function validateNumericSetting(val, min, max, defaultVal) {
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) return defaultVal;
  return Math.max(min, Math.min(max, Math.round(num)));
}

module.exports = {
  ALLOWED_MEDIA_EXTENSIONS,
  resolveInside,
  assertInside,
  assertAllowedMediaFolder,
  assertAllowedMediaFile,
  assertAccountId,
  assertChromeProfileDirName,
  sanitizeFilePart,
  sanitizeCustomFileName: sanitizeFilePart,
  sanitizeProxyUrl,
  validateNumericSetting
};

