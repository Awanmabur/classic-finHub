const Joi = require('joi');
module.exports = Joi.object({ name: Joi.string().allow(''), customer: Joi.string().allow(''), amount: Joi.number(), currency: Joi.string().allow(''), fee: Joi.number(), phone: Joi.string().allow(''), moduleKey: Joi.string().allow('') }).unknown(true);
