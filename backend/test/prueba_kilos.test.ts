/** La ruta temporal de la prueba del flujo de soporte está APAGADA por defecto (no existe en producción salvo que se active a propósito). */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { createApp } = await import('../src/app.js');
let server: Server; let base = '';
describe('ruta temporal /api/prueba-kilos', () => {
  beforeAll(async () => { server = createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  it('apagada por defecto: no está expuesta (sin autenticación cae en 401, nunca 200 ni 500)', async () => {
    expect((await fetch(`${base}/api/prueba-kilos?valor=1250`)).status).toBe(401);
    expect((await fetch(`${base}/api/prueba-kilos`)).status).toBe(401);
  });
});
