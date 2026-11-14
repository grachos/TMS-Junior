/**
 * Light TMS - HTTP server entrypoint.
 */

import { createApp } from './app.js';
import { config } from './config/env.js';
import { problemaSecretoJwt } from './modules/auth/jwt.js';
import { iniciarWatcherPush } from './modules/push/push.watcher.js';

// Refuse to start with a forgeable JWT secret: anyone could sign an admin token.
const problemaJwt = problemaSecretoJwt(config().auth.jwtSecret);
if (problemaJwt) {
  // eslint-disable-next-line no-console
  console.error(
    `[auth] ${problemaJwt} La API no arranca así. Configura JWT_SECRET con un valor aleatorio de 32+ caracteres, ` +
      "p.ej.: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
  );
  process.exit(1);
}

const app = createApp();
const { port, name, env } = config().app;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[${name}] API listening on http://localhost:${port} (env=${env})`);
});

iniciarWatcherPush();
