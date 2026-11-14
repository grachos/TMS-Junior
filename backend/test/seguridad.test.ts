import { describe, expect, it } from 'vitest';
import { cabeceraCsp, construirCsp, cspModoDe, hashesScriptsEnLinea } from '../src/http/seguridad.js';
import { hashIdentificador } from '../src/modules/auth/accesoGuard.js';

describe('CSP', () => {
  it('el modo por defecto solo reporta; enforce y off se respetan; basura cae a reportar', () => {
    expect(cspModoDe(undefined)).toBe('report');
    expect(cspModoDe('ENFORCE')).toBe('enforce');
    expect(cspModoDe('off')).toBe('off');
    expect(cspModoDe('cualquier cosa')).toBe('report');
  });

  it('la cabecera cambia de nombre según el modo y off no envía nada', () => {
    expect(cabeceraCsp('report', [])?.nombre).toBe('Content-Security-Policy-Report-Only');
    expect(cabeceraCsp('enforce', [])?.nombre).toBe('Content-Security-Policy');
    expect(cabeceraCsp('off', [])).toBeNull();
  });

  it('saca el hash de los scripts EN LÍNEA y no de los que tienen src', () => {
    const html = '<script>var a=1;</script><script type="module" src="/a.js"></script><script> </script><script>var b=2;</script>';
    const h = hashesScriptsEnLinea(html);
    expect(h).toHaveLength(2);
    expect(h.every((x) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(x))).toBe(true);
  });

  it('la política no permite scripts en línea arbitrarios, objetos ni ser embebida por otros sitios', () => {
    const csp = construirCsp(["'sha256-abc='"]);
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toContain("'self'");
    expect(script).toContain("'sha256-abc='");
    expect(script).not.toContain('unsafe-inline');
    expect(script).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});

describe('hash del identificador', () => {
  it('no distingue mayúsculas ni espacios, y nunca devuelve el texto original', () => {
    const h = hashIdentificador('  Admin@TMS.local ');
    expect(h).toBe(hashIdentificador('admin@tms.local'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('admin');
    expect(hashIdentificador('')).toBeNull();
    expect(hashIdentificador(undefined)).toBeNull();
  });
});
