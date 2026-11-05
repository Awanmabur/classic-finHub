'use strict';
const express=require('express');
const {rateLimit}=require('express-rate-limit');
const router=express.Router();
router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');next();});
router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false}));
// This machine endpoint precedes browser sessions and CSRF. Its authentication
// is a per-device raw-body HMAC; browser tenant routes retain normal CSRF.
router.use(express.json({limit:'16kb',strict:true,verify(req,res,buffer){req.smsRawBody=Buffer.from(buffer);}}));
router.post('/:deviceId',async(req,res,next)=>{try{
  if(!req.is('application/json')||!Buffer.isBuffer(req.smsRawBody))return res.status(415).json({error:'application/json is required'});
  const result=await require('../tenant/services/smsCapture.service').receive(req.params.deviceId,req.smsRawBody,req.body,
    {timestamp:req.get('X-SMS-Timestamp'),signature:req.get('X-SMS-Signature')});
  res.status(result.duplicate?200:202).json(result);
}catch(error){next(error);}});
module.exports=router;
