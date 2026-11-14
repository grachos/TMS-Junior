/**
 * Light TMS - Envío de correo (SMTP). Hoy solo lo usa "recuperar contraseña".
 * Si falta la configuración no lanza: avisa en el log y devuelve false (la
 * recuperación responde igual para no delatar nada; el administrador ve el aviso).
 */

import nodemailer from 'nodemailer';
import { config } from '../../config/env.js';

export interface Correo {
  para: string;
  asunto: string;
  texto: string;
  html: string;
}

/** Envía un correo. Devuelve true si el servidor SMTP lo aceptó. Nunca lanza. */
export async function enviarCorreo(c: Correo): Promise<boolean> {
  const cfg = config().correo;
  if (!cfg.host || !cfg.user || !cfg.pass) {
    // eslint-disable-next-line no-console
    console.error('[correo] Falta configurar SMTP_HOST / SMTP_USER / SMTP_PASS: no se envió el correo.');
    return false;
  }
  try {
    const transporte = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10_000, socketTimeout: 15_000,
    });
    await transporte.sendMail({ from: cfg.from, to: c.para, subject: c.asunto, text: c.texto, html: c.html });
    return true;
  } catch (e) {
    // El motivo va al log; nunca contiene la contraseña SMTP.
    // eslint-disable-next-line no-console
    console.error('[correo] No se pudo enviar:', (e as Error).message);
    return false;
  }
}
