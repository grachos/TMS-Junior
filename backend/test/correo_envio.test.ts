/** Lo que realmente se le entrega al servidor SMTP (nodemailer simulado: no hay red). */
import { describe, expect, it, vi } from 'vitest';

process.env.SMTP_HOST = 'smtp.prueba.test';
process.env.SMTP_USER = 'no-responder@prueba.test';
process.env.SMTP_PASS = 'clave-smtp-secreta';
process.env.SMTP_FROM = 'Konekto <no-responder@prueba.test>';
process.env.SMTP_REPLY_TO = 'soporte@prueba.test';

const enviados: Record<string, unknown>[] = [];
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: async (o: Record<string, unknown>) => { enviados.push(o); } }) },
}));

const { enviarCorreo } = await import('../src/modules/auth/correo.js');
const { armarCorreo } = await import('../src/modules/auth/recuperacion.js');

describe('envío del correo de recuperación', () => {
  it('se marca como automático y lleva Reply-To cuando está configurado', async () => {
    const c = { ...armarCorreo('Ana', 'https://s.co/restablecer?token=abc'), para: 'ana@x.co' };
    expect(await enviarCorreo(c)).toBe(true);
    const o = enviados.at(-1)!;
    expect(o.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' });
    expect(o.replyTo).toBe('soporte@prueba.test');
    expect(o.from).toBe('Konekto <no-responder@prueba.test>');
    expect(o.to).toBe('ana@x.co');
    expect(JSON.stringify(o)).not.toContain('clave-smtp-secreta'); // la contraseña SMTP nunca viaja en el mensaje
  });

  it('manda texto Y html, y el texto visible del enlace es el mismo que su destino', () => {
    const c = armarCorreo('Ana', 'https://s.co/restablecer?token=abc');
    expect(c.texto).toContain('https://s.co/restablecer?token=abc');
    const m = /<a href="([^"]+)">([^<]+)<\/a>/.exec(c.html)!;
    expect(m[1]).toBe(m[2]); // sin "haz clic aquí" que oculte otra dirección
    expect(c.html).not.toMatch(/<img|<button|style=/i);
  });
});
