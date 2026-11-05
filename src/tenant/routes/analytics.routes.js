'use strict';
const requirePermission=require('../../middleware/requirePermission');
const reportThrottle=require('../../platform/services/actionThrottle.service').analytics;
module.exports=function routes({renderTenant}){
 const router=require('express').Router();
 const ctrl=require('../controllers/analytics.controller')({renderTenant});
 router.get('/',requirePermission('analytics.view'),reportThrottle,ctrl.index);
 router.get('/export.csv',requirePermission('analytics.export'),reportThrottle,ctrl.exportCsv);
 return router;
};
