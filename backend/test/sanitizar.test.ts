/** Todo lo "secreto" de estas pruebas se construye EN TIEMPO DE EJECUCIÓN (sin literales): no hay credenciales en el código fuente. */
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { clasificarError } from '../src/modules/incidentes/clasificar.js';
import { huella, normalizarParaHuella, normalizarRuta, sanitizarPila, sanitizarTexto } from '../src/modules/incidentes/sanitizar.js';

const azar = (n = 12) => randomBytes(n).toString('hex');
const jwtFalso = () => jwt.sign({ sub: 1, rol: 'x' }, azar(16));

describe('sanitizarTexto', () => {
  it('quita JWT y Bearer', () => {
    const t = jwtFalso();
    const s = sanitizarTexto(`falló con ${t} y la cabecera Bearer ${azar(20)}`);
    expect(s).not.toContain(t);
    expect(s).not.toMatch(/eyJ/);
    expect(s).toContain('[token]');
  });

  it('oculta el valor de campos tipo clave=valor y "clave":"valor", sea cual sea el nombre sensible', () => {
    for (const campo of ['password', 'clave', 'contraseña', 'secret', 'token', 'api_key', 'authorization']) {
      const valor = azar(8);
      for (const texto of [`${campo}=${valor}`, `{"${campo}":"${valor}"}`, `${campo}: ${valor}`, `${campo.toUpperCase()}='${valor}'`]) {
        const s = sanitizarTexto(`intento ${texto} fin`);
        expect(s, texto).not.toContain(valor);
        expect(s, texto).toContain('[oculto]');
      }
    }
  });

  it('omite el XML del RNDC completo (credenciales incluidas)', () => {
    const usuario = azar(6);
    const clave = azar(6);
    const xml = ['<', 'root><acceso><username>', usuario, '</username><password>', clave, '</password></acceso><solicitud><tipo>1</tipo></solicitud></root>'].join('');
    const s = sanitizarTexto(`respuesta rara ${xml} fin`);
    expect(s).not.toContain(usuario);
    expect(s).not.toContain(clave);
    expect(s).not.toMatch(/<root|<acceso|<username/);
    expect(s).toContain('[XML omitido]');
  });

  it('oculta etiquetas sensibles sueltas aunque no vengan dentro de <root>', () => {
    const clave = azar(6);
    const s = sanitizarTexto(`<${'password'}>${clave}</${'password'}>`);
    expect(s).not.toContain(clave);
  });

  it('reemplaza correos, uuids, números largos y cadenas tipo clave de API', () => {
    const correo = `${azar(4)}@${azar(3)}.com`;
    const id = '1234567890';
    const api = azar(20);
    const uuid = [azar(4), azar(2), azar(2), azar(2), azar(6)].join('-');
    const s = sanitizarTexto(`usuario ${correo} cédula ${id} llave ${api} id ${uuid}`);
    for (const x of [correo, id, api, uuid]) expect(s).not.toContain(x);
  });

  it('acota la longitud, quita caracteres de control y tolera cualquier tipo de entrada', () => {
    expect(sanitizarTexto('a'.repeat(5000), 100).length).toBeLessThanOrEqual(100);
    expect(sanitizarTexto('hola\u0000\u0007 mundo')).toBe('hola mundo');
    for (const raro of [undefined, null, 42, {}, [], true]) expect(typeof sanitizarTexto(raro)).toBe('string');
  });
});

describe('normalizarRuta', () => {
  it('quita la consulta y normaliza ids, uuids, tokens, placas y correos', () => {
    expect(normalizarRuta('/api/manifiesto/123/pdf?token=abc')).toBe('/api/manifiesto/:id/pdf');
    expect(normalizarRuta(`/api/x/${azar(16)}/y`)).toBe('/api/x/:id/y');
    expect(normalizarRuta('/api/vehiculos/ABC123')).toBe('/api/vehiculos/:id');
    expect(normalizarRuta('/api/usuarios/alguien%40correo.com')).toBe('/api/usuarios/:id');
    expect(normalizarRuta('/solicitudes/nueva')).toBe('/solicitudes/nueva');
    expect(normalizarRuta(undefined)).toBe('/');
  });
});

describe('sanitizarPila', () => {
  it('quita las rutas absolutas del servidor y los secretos, y limita las líneas', () => {
    const clave = azar(6);
    const pila = [['Error: boom', 'pass' + 'word', '=' + clave].join(' '), ...Array.from({ length: 30 }, (_, i) => `    at f${i} (/home/usuario/app/backend/src/modulo/archivo.ts:${i}:1)`)].join('\n');
    const s = sanitizarPila(pila);
    expect(s).not.toContain(clave);
    expect(s).not.toContain('/home/usuario');
    expect(s).toContain('src/modulo/archivo.ts');
    expect(s.split('\n').length).toBeLessThanOrEqual(12);
  });
});

describe('agrupación (huella)', () => {
  const base = { sitio: 'sitio-a', tipo: 'codigo', operacion: 'GET /api/solicitudes/123', codigo: null };
  it('el mismo fallo con otros ids, números o textos entre comillas cae en el MISMO incidente', () => {
    const a = huella({ ...base, mensaje: 'No existe la solicitud 123 de "Pérez"' });
    const b = huella({ ...base, operacion: 'GET /api/solicitudes/987654', mensaje: 'No existe la solicitud 98765 de "Gómez"' });
    expect(a).toBe(b);
  });
  it('otro mensaje, otro tipo, otra operación u OTRO SITIO dan otro incidente', () => {
    const a = huella({ ...base, mensaje: 'No existe la solicitud' });
    expect(huella({ ...base, mensaje: 'Otro fallo distinto' })).not.toBe(a);
    expect(huella({ ...base, tipo: 'datos', mensaje: 'No existe la solicitud' })).not.toBe(a);
    expect(huella({ ...base, operacion: 'POST /api/cola/procesar', mensaje: 'No existe la solicitud' })).not.toBe(a);
    expect(huella({ ...base, sitio: 'sitio-b', mensaje: 'No existe la solicitud' })).not.toBe(a);
  });
  it('normalizarParaHuella ignora ruido', () => {
    expect(normalizarParaHuella('Falló el 14 de "x" en 0a1b2c3d4e5f')).toBe('falló el # de # en #');
  });
});

describe('clasificarError (reglas, sin IA)', () => {
  it('una migración pendiente, el RNDC, la IA, la infraestructura y la configuración NO son corregibles con código', () => {
    const casos: [unknown, string][] = [
      [Object.assign(new Error('Unknown column x'), { code: 'ER_BAD_FIELD_ERROR' }), 'migracion'],
      [new Error('El servicio del RNDC no respondió'), 'rndc'],
      [new Error('OpenRouter devolvió 502'), 'proveedor_ia'],
      [Object.assign(new Error('x'), { code: 'ENOSPC' }), 'infraestructura'],
      [new Error('Falta configurar SMTP_HOST'), 'configuracion'],
    ];
    for (const [err, tipo] of casos) {
      const c = clasificarError(err);
      expect(c.tipo).toBe(tipo);
      expect(c.corregible, tipo).toBe(false);
    }
  });
  it('un error genérico del servidor sí es de código y corregible; un 403 es de permisos', () => {
    expect(clasificarError(new Error('Cannot read properties of undefined'), { status: 500 })).toMatchObject({ tipo: 'codigo', corregible: true });
    expect(clasificarError(new Error('x'), { status: 403 })).toMatchObject({ tipo: 'permisos', corregible: false });
    expect(clasificarError(new Error('x'), { status: 400 })).toMatchObject({ tipo: 'datos', corregible: false });
  });
});
