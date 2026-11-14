/**
 * La previsualización del XML (botón "Ver XML" de Cola y lo que el modo seguro
 * guarda en cola_envios.respuesta_rndc) traía la clave REAL del RNDC dentro de
 * <acceso><password>. Cualquier usuario con acceso a Cola la veía, y el chatbot
 * podía leerla de cola_envios. La previsualización debe enmascararla; el envío
 * real al RNDC debe seguir llevando la clave verdadera.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RndcClient } from '../src/rndc/RndcClient.js';

const clave = () => `k-${randomBytes(9).toString('hex')}`;

describe('RNDC: la clave no aparece en la previsualización', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('previewXmlInterno enmascara la clave y conserva el resto del XML', () => {
    const secreto = clave();
    const xml = new RndcClient('usuario-rndc', secreto).previewXmlInterno(3, '<CONSECUTIVOREMESA>1</CONSECUTIVOREMESA>');
    expect(xml).not.toContain(secreto);
    expect(xml).toContain('<password>********</password>');
    expect(xml).toContain('<username>usuario-rndc</username>');
    expect(xml).toContain('<CONSECUTIVOREMESA>1</CONSECUTIVOREMESA>');
  });

  it('el envío real al RNDC sí lleva la clave verdadera', async () => {
    const secreto = clave();
    let cuerpo = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      cuerpo = String(init.body);
      return new Response('<return>&lt;root&gt;&lt;ingresoid&gt;123&lt;/ingresoid&gt;&lt;/root&gt;</return>', { status: 200 });
    }));
    await new RndcClient('usuario-rndc', secreto).ingresarXml(3, '<CONSECUTIVOREMESA>1</CONSECUTIVOREMESA>');
    expect(cuerpo).toContain(secreto);
    expect(cuerpo).not.toContain('********');
  });
});
