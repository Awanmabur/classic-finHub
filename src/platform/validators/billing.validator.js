const Joi = require('joi');
module.exports = Joi.object({ amount: Joi.any(), email: Joi.string().email().allow(''), phone: Joi.string().allow(''), amount: Joi.number(), moduleKey: Joi.string(), reason: Joi.string().allow('') }).unknown(true);
