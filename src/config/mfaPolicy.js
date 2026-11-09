'use strict';
// Enforcement is enabled unless the operator explicitly opts out. Turning the
// requirement off never changes enrollment records, encryption keys or sessions
// into proof that an authenticator was verified.
function enabled(input=process.env){return input.MFA_ENABLED!=='false';}
module.exports={enabled};
