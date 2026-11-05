module.exports = {
  passwordPolicy: { minLength: 14, requireNumber: true, requireSymbol: true },
  highRiskActions: ['large_withdrawal','large_forex_trade','transfer_reversal','forex_rate_change','day_close_discrepancy','role_permission_change','tenant_billing_change','module_activation'],
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
};
