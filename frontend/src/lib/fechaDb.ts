/**
 * Las fechas de la base llegan como texto SIN zona horaria ("2026-11-16 00:01:02") y el servidor las guarda en UTC.
 * `new Date("2026-11-16T00:01:02")` las leería como hora LOCAL (5 horas corridas en Colombia). Aquí se leen como UTC;
 * si ya traen zona (ISO con "Z" o desfase) se respetan.
 */
export function fechaDb(v: unknown): Date {
  const s = String(v ?? '').trim();
  const sinZona = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  return new Date(sinZona ? `${s.replace(' ', 'T')}Z` : s);
}

export const fechaCorta = (v: unknown): string => fechaDb(v).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
