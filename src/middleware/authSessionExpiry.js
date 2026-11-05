'use strict';
// Absolute expiry complements express-session's sliding/idle timeout.
// A session can't remain valid forever by continuously making requests.
const ABSOLUTE_AUTH_MS = 8 * 60 * 60 * 1000;
function validAuthAge(timestamp, now = Date.now()) {
  return Number.isSafeInteger(timestamp) && timestamp <= now && (now - timestamp) < ABSOLUTE_AUTH_MS;
}
module.exports = { validAuthAge, ABSOLUTE_AUTH_MS };
