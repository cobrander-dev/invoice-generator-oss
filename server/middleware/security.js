'use strict';
const helmet = require('helmet');
function securityHeaders(production) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        // Existing business templates use style attributes; no inline JS/eval allowed.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'self'", 'blob:'],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: production ? { maxAge: 31536000, includeSubDomains: false } : false,
  });
}
module.exports = { securityHeaders };
