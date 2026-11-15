import { describe, expect, it } from 'vitest';
import { enviarCorreo } from '../src/modules/auth/correo.js';
import { armarCorreo } from '../src/modules/auth/recuperacion.js';

describe('correo', () => {
  it('sin SMTP configurado no lanza: devuelve false (y avisa en el log)', async () => {
    expect(await enviarCorreo({ para: 'a@b.co', asunto: 'x', texto: 'x', html: 'x' })).toBe(false);
  });

  it('el correo de recuperación incluye el enlace y el vencimiento, y escapa el nombre en el HTML', () => {
    const c = armarCorreo('<img src=x onerror=alert(1)>', 'https://s.co/restablecer?token=abc');
    expect(c.texto).toContain('https://s.co/restablecer?token=abc');
    expect(c.texto).toMatch(/30 minutos/);
    expect(c.html).not.toContain('<img');
    expect(c.html).toContain('&#60;img');
  });
});
