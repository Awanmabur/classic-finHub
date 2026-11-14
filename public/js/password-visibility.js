'use strict';
(() => {
 for(const button of document.querySelectorAll('[data-password-toggle]')){
  const id=button.getAttribute('aria-controls');
  const input=id?document.getElementById(id):null;
  if(!input)continue;
  button.addEventListener('click',()=>{
   const visible=input.type==='password';
   input.type=visible?'text':'password';
   button.setAttribute('aria-pressed',String(visible));
   button.setAttribute('aria-label',visible?'Hide password':'Show password');
   const icon=button.querySelector('i');
   icon?.classList.toggle('fa-eye',!visible);
   icon?.classList.toggle('fa-eye-slash',visible);
  });
 }
})();
