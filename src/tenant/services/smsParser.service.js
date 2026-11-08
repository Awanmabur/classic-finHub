'use strict';

// Explicit confirmation profile, not a claim of compatibility with every SMS
// produced by a mobile-money provider. Enrolment must select the network and
// its sender. Unrecognised or changed provider wording stays in the review inbox.
// Supported fixture:
// MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345
const {smsNetworks:NETWORKS}=require('../../config/mobileNetworks');
const AMOUNT = '(?:0|[1-9]\\d{0,10}|[1-9]\\d{0,2}(?:,\\d{3}){1,3})(?:\\.\\d{1,2})?';
const confirmation = new RegExp(
  `^(MTN SSD|MTN|Airtel|M-Pesa) Cash (In|Out): (UGX|USD|SSP|KES) (${AMOUNT}); Fee: (UGX|USD|SSP|KES) (${AMOUNT}); Customer: ([^;\\r\\n]{2,120}); Ref: ([A-Za-z0-9._:/-]{5,100})(?:; Agent Balance: (UGX|USD|SSP|KES) (${AMOUNT}))?$`,
  'i'
);
const review = reasonCode => ({state:'needs_review', fields:null, reasonCode});

function parseSms(body, {network} = {}) {
  if (!NETWORKS.includes(network)) return review('unsupported_network');
  if (typeof body !== 'string' || !body.trim()) return review('empty_message');
  if (body.length > 2000) return review('message_too_long');
  // Never interpret forwarded messages, multiline instructions, OTPs, failed
  // operations or reversals as new successful cash-in/out instructions.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(body) ||
      /\b(?:forwarded|reversed?|reversal|failed|failure|pending|cancelled|canceled|OTP|password|PIN)\b/i.test(body)) {
    return review('unsafe_message');
  }
  const match = confirmation.exec(body.trim());
  if (!match) return review('unsupported_format');
  const matchedNetwork = NETWORKS.find(value => value.toLowerCase() === match[1].toLowerCase());
  if (matchedNetwork !== network) return review('network_mismatch');
  const currency = match[3].toUpperCase();
  if (match[5].toUpperCase() !== currency) return review('currency_mismatch');
  if(match[9]&&match[9].toUpperCase()!==currency)return review('balance_currency_mismatch');
  const fields = {
    operation: match[2].toLowerCase() === 'in' ? 'cash_in' : 'cash_out',
    customer: match[7].trim(),
    network: matchedNetwork,
    networkReference: match[8],
    currency,
    amount: match[4].replaceAll(',', ''),
    fee: match[6].replaceAll(',', '')
  };
  if(match[10]){fields.observedWalletBalance=match[10].replaceAll(',', '');fields.observationEvidenceReference=fields.networkReference;}
  try {
    // Share amount, currency, customer and reference constraints with the manual
    // entry service. This key validates the shape only; it is never persisted.
    require('./mobileMoney.service').validate({
      ...fields, idempotencyKey:'00000000-0000-4000-8000-000000000000'
    }, fields.operation);
  } catch {
    return review('invalid_fields');
  }
  return {state:'parsed', fields, reasonCode:'explicit_confirmation'};
}

module.exports = {parseSms, NETWORKS};
