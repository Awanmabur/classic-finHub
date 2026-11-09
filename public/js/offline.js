/* Compatibility entry for previously saved workspace pages. */
'use strict';
(() => {
  const script = document.createElement('script');
  const query = document.currentScript ? new URL(document.currentScript.src).search : '';
  script.src = '/js/offline-workspace.js' + query;
  script.defer = true;
  document.head.append(script);
})();
