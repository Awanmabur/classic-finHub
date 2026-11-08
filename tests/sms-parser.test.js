'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseSms, NETWORKS} = require('../src/tenant/services/smsParser.service');

const sample = 'MTN Cash In: UGX 1,000; Fee: UGX 10; Customer: Jane Doe; Ref: ABC12345';
function needsReview(body, options={network:'MTN'}) {
  const result = parseSms(body, options);
  assert.equal(result.state, 'needs_review');
  assert.equal(result.fields, null);
  return result.reasonCode;
}

test('explicit confirmation parses without inferring fee or direction', () => {
  assert.deepEqual(parseSms(sample, {network:'MTN'}), {
    state:'parsed', reasonCode:'explicit_confirmation', fields:{
      operation:'cash_in', customer:'Jane Doe', network:'MTN', networkReference:'ABC12345',
      currency:'UGX', amount:'1000', fee:'10'
    }
  });
  const out = parseSms('m-pesa cash out: KES 2,450.50; fee: KES 0; customer: Jane Doe; ref: QE312345', {network:'M-Pesa'});
  assert.equal(out.state, 'parsed');
  assert.equal(out.fields.operation, 'cash_out');
  assert.equal(out.fields.amount, '2450.50');
  assert.equal(out.fields.fee, '0');
  assert.equal(out.fields.network, 'M-Pesa');
  assert.equal(parseSms(sample.replace('MTN', 'Airtel'), {network:'Airtel'}).state, 'parsed');
  assert(Object.isFrozen(NETWORKS));
});

test('device network must match the confirmation network', () => {
  assert.equal(needsReview(sample, {network:'Airtel'}), 'network_mismatch');
  assert.equal(needsReview(sample, {network:'Other'}), 'unsupported_network');
  assert.equal(needsReview(sample, {}), 'unsupported_network');
});

test('MTN South Sudan is distinct from MTN and SSP confirmations retain exact cents',()=>{
 const text='MTN SSD Cash In: SSP 1,000.25; Fee: SSP 10.05; Customer: Jane Doe; Ref: SSD12345; Agent Balance: SSP 5,000.75';
 const parsed=parseSms(text,{network:'MTN SSD'});
 assert.equal(parsed.state,'parsed');assert.equal(parsed.fields.network,'MTN SSD');assert.equal(parsed.fields.currency,'SSP');
 assert.equal(parsed.fields.amount,'1000.25');assert.equal(parsed.fields.fee,'10.05');assert.equal(parsed.fields.observedWalletBalance,'5000.75');
 assert.equal(needsReview(text,{network:'MTN'}),'network_mismatch');
 assert.equal(needsReview(sample,{network:'MTN SSD'}),'network_mismatch');
 assert.equal(needsReview(text.replace('Fee: SSP','Fee: USD'),{network:'MTN SSD'}),'currency_mismatch');
 assert.equal(needsReview(text.replace('1,000.25','1,000.255'),{network:'MTN SSD'}),'unsupported_format');
 assert.equal(needsReview('MTN SSD received money, amount unknown, Ref SSD12345',{network:'MTN SSD'}),'unsupported_format');
});

test('ambiguous wallet messages and incomplete confirmations stay for review', () => {
  for (const body of [
    'You have received UGX 1,000 from Jane Doe. ID ABC12345.',
    sample.replace('; Fee: UGX 10', ''),
    sample.replace('Cash In', 'Transfer'),
    sample + '; Ref: OTHER123',
    sample + ' account balance UGX 5000',
    sample.replace('UGX 1,000', 'USD 1,000'),
    sample.replace('Ref: ABC12345', 'Ref: 1234'),
    sample.replace('Jane Doe', 'A')
  ]) needsReview(body);
});

test('amount grouping and precision are strict and never guessed', () => {
  for (const value of ['1,00', '1,000,00', '1.000,00', '1e3', '-1000', '+1000', '0', '10000000001', '01,000', '1,000.00']) {
    needsReview(sample.replace('UGX 1,000', `UGX ${value}`));
  }
  needsReview(sample.replace('Fee: UGX 10', 'Fee: UGX 1001'));
  assert.equal(needsReview(sample.replace('Fee: UGX 10', 'Fee: KES 10')), 'currency_mismatch');
  assert.equal(parseSms(sample.replace('1,000', '1000'), {network:'MTN'}).state, 'parsed');
  needsReview(sample.replaceAll('UGX', 'KES').replace('1,000', '1,000.001'));
});

test('forwarding, reversal, OTP, multiline and control characters cannot auto-parse', () => {
  for (const body of [
    'Forwarded: ' + sample,
    sample + '\n',
    sample.replace('Jane Doe', 'Jane\nDoe'),
    sample.replace('Jane Doe', 'Jane\u0000Doe'),
    sample.replace('Jane Doe', 'Jane\u2028Doe'),
    sample.replace('Jane Doe', 'OTP 123456'),
    sample.replace('Jane Doe', 'reversed transaction'),
    sample.replace('Jane Doe', 'failed transaction'),
    sample.replace('Jane Doe', 'pending transaction')
  ]) assert.equal(needsReview(body), 'unsafe_message');
});

test('missing and oversized bodies cannot produce instructions', () => {
  assert.equal(needsReview(undefined), 'empty_message');
  assert.equal(needsReview(''), 'empty_message');
  assert.equal(needsReview({body:sample}), 'empty_message');
  assert.equal(needsReview('A'.repeat(2001)), 'message_too_long');
});


test('only explicitly labelled agent balances become dated provider wallet evidence',()=>{
  const parsed=parseSms(sample+'; Agent Balance: UGX 500,000',{network:'MTN'});
  assert.equal(parsed.state,'parsed');
  assert.equal(parsed.fields.observedWalletBalance,'500000');
  assert.equal(parsed.fields.observationEvidenceReference,'ABC12345');
  const zero=parseSms(sample+'; Agent Balance: UGX 0',{network:'MTN'});
  assert.equal(zero.state,'parsed');assert.equal(zero.fields.observedWalletBalance,'0');
  const cents=parseSms('M-Pesa Cash Out: KES 100.25; Fee: KES 1.25; Customer: Jane Doe; Ref: QE312345; Agent Balance: KES 2,450.50',{network:'M-Pesa'});
  assert.equal(cents.state,'parsed');assert.equal(cents.fields.observedWalletBalance,'2450.50');
  assert.equal(needsReview(sample+'; Agent Balance: KES 500,000'),'balance_currency_mismatch');
  for(const suffix of ['; Balance: UGX 500,000','; Customer Balance: UGX 500,000','; Wallet Balance: UGX 500,000','; Agent Balance: UGX -500','; Agent Balance: UGX 50,00','; Agent Balance: UGX 500,000; Agent Balance: UGX 400,000'])needsReview(sample+suffix);
  assert.equal('observedWalletBalance' in parseSms(sample,{network:'MTN'}).fields,false,'Missing provider balance must remain unknown');
});
