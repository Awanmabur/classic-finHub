'use strict';
const fs = require('node:fs');
const path = require('node:path');
const retainedKeyFile = path.resolve(__dirname, '../../.classicfin-dev-mfa.key');

function unavailable(code) {
  const messages = {
    MFA_KEY_FILE_UNSAFE: 'The retained development MFA key must be a private regular file, not a symlink.',
    MFA_KEY_FILE_INVALID: 'The retained development MFA key is invalid. Restore the original key before restarting.',
    MFA_KEY_FILE_UNREADABLE: 'The retained development MFA key could not be read. Restore access before restarting.'
  };
  return Object.assign(new Error(messages[code]), { code, status: 503 });
}

function loadDevelopmentMfaKey({ env = process.env, keyFile = retainedKeyFile } = {}) {
  if ((env.NODE_ENV && env.NODE_ENV !== 'development') || env.MFA_ENCRYPTION_KEY) return false;
  let before;
  try {
    before = fs.lstatSync(keyFile);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw unavailable('MFA_KEY_FILE_UNREADABLE');
  }
  if (before.isSymbolicLink() || !before.isFile()) throw unavailable('MFA_KEY_FILE_UNSAFE');
  let descriptor;
  try {
    descriptor = fs.openSync(keyFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
      (process.platform !== 'win32' && (current.mode & 0o077) !== 0)) throw unavailable('MFA_KEY_FILE_UNSAFE');
    if (current.size < 64 || current.size > 256) throw unavailable('MFA_KEY_FILE_INVALID');
    const key = fs.readFileSync(descriptor, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) throw unavailable('MFA_KEY_FILE_INVALID');
    env.MFA_ENCRYPTION_KEY = key;
    return true;
  } catch (error) {
    if (['MFA_KEY_FILE_UNSAFE', 'MFA_KEY_FILE_INVALID'].includes(error.code)) throw error;
    throw unavailable('MFA_KEY_FILE_UNREADABLE');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

module.exports = { loadDevelopmentMfaKey };
