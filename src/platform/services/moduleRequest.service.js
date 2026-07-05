const { moduleRequests, approveModuleRequest, rejectModuleRequest } = require('../../data/store');
module.exports = { listRequests: () => moduleRequests, approveModuleRequest, rejectModuleRequest };
