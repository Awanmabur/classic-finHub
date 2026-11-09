'use strict';
// Development defers enrollment until explicitly enabled. Production retains
// MFA by default. Neither mode changes stored enrollments, keys or verification
// timestamps, and an invalid nonempty flag fails closed.
function status(input=process.env){
 const value=typeof input.MFA_ENABLED==='string'?input.MFA_ENABLED.trim().toLowerCase():input.MFA_ENABLED;
 if(value==='true'||value==='false')return{enabled:value==='true',mode:value==='true'?'enabled':'disabled',source:'explicit'};
 if(value!==undefined&&value!==null&&value!=='')return{enabled:true,mode:'enabled',source:'invalid_value'};
 const production=input.NODE_ENV==='production';
 return{enabled:production,mode:production?'enabled':'disabled',source:production?'production_default':'development_default'};
}
function enabled(input=process.env){return status(input).enabled;}
module.exports={enabled,status};
