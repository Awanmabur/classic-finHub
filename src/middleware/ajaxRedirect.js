'use strict';
// Opt-in form requests receive the next location without fetching that page
// invisibly and then navigating to it a second time. CSRF and live authorization
// still run before the route; this header grants no access.
function target(value){
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020\u007f]/.test(value))return null;
 const url=new URL(value,'https://classicfin.invalid');
 return url.origin==='https://classicfin.invalid'?url.pathname+url.search+url.hash:null;
}
function ajaxRedirect(req,res,next){
 if(req.method!=='POST'||req.get('X-ClassicFin-Redirect')!=='json')return next();
 res.redirect=function redirect(statusOrPath,path){
  const destination=target(typeof statusOrPath==='number'?path:statusOrPath);
  res.setHeader('Cache-Control','private, no-store');
  if(!destination)return res.status(400).type('text/plain').send('Open this action from its page to continue.');
  const notice=req.session?.flash;
  const flash=notice&&typeof notice.message==='string'?{type:notice.type,message:notice.message}:null;
  // Failed sign-in/MFA keeps the form open. Its error has already been delivered
  // and must not appear later on an unrelated page. Success awaits navigation.
  if(flash?.type==='bad')delete req.session.flash;
  return res.status(200).json({redirect:destination,flash});
 };
 next();
}
module.exports={ajaxRedirect,target};
