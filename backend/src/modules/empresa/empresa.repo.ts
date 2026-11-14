/**
 * Light TMS - Own company master (single row id=1). Port of EmpresaRepo.php.
 *
 * The consecutivo reserve-and-format methods use a compare-and-set UPDATE for
 * optimistic concurrency, exactly like the PHP. They accept an optional
 * connection so the despacho transaction (Phase 4) reserves numbers atomically
 * on the same connection.
 */

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { db } from '../../db/pool.js';

type Queryable = Pool | PoolConnection;

export interface Empresa {
  id: number;
  tipo_id: string;
  nit: string;
  /** Credenciales RNDC — antes en .env (RNDC_USERNAME/RNDC_PASSWORD), ahora aquí. */
  rndc_username: string | null;
  rndc_password: string | null;
  razon_social: string | null;
  /** Encabezado de los PDF de manifiesto/remesa (dirección, teléfono, ciudad). */
  direccion: string | null;
  telefono: string | null;
  cod_municipio: string | null;
  municipio_nombre: string | null;
  nro_poliza: string | null;
  /** Aseguradora de mercancía peligrosa — tabla "Tomador Póliza" de la Remesa. */
  aseguradora_carga_nombre: string | null;
  aseguradora_carga_nit: string | null;
  poliza_carga_numero: string | null;
  poliza_carga_vencimiento: string | null;
  emf: string | null;
  consecutivo_remesa: string;
  consecutivo_manifiesto: string;
}

const DEFAULTS: Empresa = {
  id: 1,
  tipo_id: 'N',
  nit: '',
  rndc_username: '',
  rndc_password: '',
  razon_social: '',
  direccion: '',
  telefono: '',
  cod_municipio: '',
  municipio_nombre: '',
  nro_poliza: '',
  aseguradora_carga_nombre: '',
  aseguradora_carga_nit: '',
  poliza_carga_numero: '',
  poliza_carga_vencimiento: '',
  emf: '',
  consecutivo_remesa: 'REM-00000',
  consecutivo_manifiesto: 'MAN-00000',
};

/** Returns the company row, or defaults. Port of obtener(). */
export async function obtener(exec: Queryable = db()): Promise<Empresa> {
  const [rows] = await exec.query<(Empresa & RowDataPacket)[]>('SELECT * FROM maestro_empresa WHERE id = 1');
  return rows[0] ?? { ...DEFAULTS };
}

/** Upserts the company row. Port of guardar(). */
export async function guardar(datos: Partial<Empresa>, exec: Queryable = db()): Promise<void> {
  const str = (v: unknown) => {
    const s = (v ?? '').toString().trim();
    return s || null;
  };
  await exec.query(
    `INSERT INTO maestro_empresa (
        id, tipo_id, nit, rndc_username, rndc_password, razon_social, direccion, telefono, cod_municipio, municipio_nombre,
        nro_poliza, aseguradora_carga_nombre, aseguradora_carga_nit, poliza_carga_numero, poliza_carga_vencimiento,
        emf, consecutivo_remesa, consecutivo_manifiesto)
     VALUES (1, :tipo_id, :nit, :rndc_username, :rndc_password, :razon_social, :direccion, :telefono, :cod_municipio, :municipio_nombre,
        :nro_poliza, :aseguradora_carga_nombre, :aseguradora_carga_nit, :poliza_carga_numero, :poliza_carga_vencimiento,
        :emf, :consecutivo_remesa, :consecutivo_manifiesto)
     ON DUPLICATE KEY UPDATE
        tipo_id = VALUES(tipo_id), nit = VALUES(nit),
        rndc_username = VALUES(rndc_username), rndc_password = VALUES(rndc_password),
        razon_social = VALUES(razon_social), direccion = VALUES(direccion), telefono = VALUES(telefono),
        cod_municipio = VALUES(cod_municipio), municipio_nombre = VALUES(municipio_nombre),
        nro_poliza = VALUES(nro_poliza),
        aseguradora_carga_nombre = VALUES(aseguradora_carga_nombre), aseguradora_carga_nit = VALUES(aseguradora_carga_nit),
        poliza_carga_numero = VALUES(poliza_carga_numero), poliza_carga_vencimiento = VALUES(poliza_carga_vencimiento),
        emf = VALUES(emf),
        consecutivo_remesa = VALUES(consecutivo_remesa),
        consecutivo_manifiesto = VALUES(consecutivo_manifiesto)`,
    {
      tipo_id: datos.tipo_id ?? 'N',
      nit: (datos.nit ?? '').toString().trim(),
      rndc_username: str(datos.rndc_username),
      rndc_password: str(datos.rndc_password),
      razon_social: str(datos.razon_social),
      direccion: str(datos.direccion),
      telefono: str(datos.telefono),
      cod_municipio: str(datos.cod_municipio),
      municipio_nombre: str(datos.municipio_nombre),
      nro_poliza: str(datos.nro_poliza),
      aseguradora_carga_nombre: str(datos.aseguradora_carga_nombre),
      aseguradora_carga_nit: str(datos.aseguradora_carga_nit),
      poliza_carga_numero: str(datos.poliza_carga_numero),
      poliza_carga_vencimiento: str(datos.poliza_carga_vencimiento),
      emf: str(datos.emf),
      consecutivo_remesa: (datos.consecutivo_remesa ?? 'REM-00000').toString().trim(),
      consecutivo_manifiesto: (datos.consecutivo_manifiesto ?? 'MAN-00000').toString().trim(),
    },
  );
}

/** Extracts the number from a "PREF-00000" consecutivo. Port of extraerNum(). */
function extraerNum(val: string): number {
  const parts = val.split('-');
  return Number.parseInt(parts.length > 1 ? (parts[1] ?? '0') : (parts[0] ?? '0'), 10) || 0;
}

const pad = (n: number, len: number) => String(n).padStart(len, '0');

/**
 * Reserva el siguiente consecutivo (PREF-00001) de `columna` en maestro_empresa.
 *
 * Debe llamarse con la conexión de la transacción del despacho
 * (confirmarDespacho): el `SELECT ... FOR UPDATE` bloquea la fila de la empresa
 * hasta el COMMIT/ROLLBACK, así que dos despachos simultáneos se turnan y cada
 * uno lee el número que dejó el anterior. Antes se leía sin bloqueo y el
 * UPDATE condicional devolvía 0 filas sin que nadie lo revisara: 10 despachos
 * simultáneos recibían el MISMO número (test/consecutivos.db.test.ts). Si la
 * transacción hace rollback, el número no se consume.
 *
 * Segunda barrera: si el UPDATE no cambia exactamente una fila (p.ej. se llamó
 * fuera de una transacción y otro proceso se adelantó) se lanza un error en
 * vez de devolver un número repetido. La tercera es la llave única de
 * migracion_v47.
 */
async function siguienteConsecutivo(
  exec: Queryable,
  columna: 'consecutivo_remesa' | 'consecutivo_manifiesto',
  prefijo: 'REM' | 'MAN',
): Promise<string> {
  const [rows] = await exec.query<RowDataPacket[]>(
    `SELECT ${columna} AS actual FROM maestro_empresa WHERE id = 1 FOR UPDATE`,
  );
  if (!rows[0]) throw new Error('No existe la fila de maestro_empresa (id = 1).');
  const prev = String(rows[0].actual ?? '');
  const fmt = `${prefijo}-` + pad(extraerNum(prev || '0') + 1, 5);
  const [res] = await exec.query<ResultSetHeader>(
    `UPDATE maestro_empresa SET ${columna} = :fmt WHERE id = 1 AND ${columna} = :prev`,
    { fmt, prev },
  );
  if (res.affectedRows !== 1) {
    throw new Error(`No se pudo reservar el consecutivo (${columna}): otro despacho lo tomó al mismo tiempo. Intenta de nuevo.`);
  }
  return fmt;
}

/** Reserves and returns the next remesa consecutivo (REM-00001). Port of siguienteRemesa(). */
export function siguienteRemesa(exec: Queryable = db()): Promise<string> {
  return siguienteConsecutivo(exec, 'consecutivo_remesa', 'REM');
}

/** Reserves and returns the next manifiesto consecutivo (MAN-00001). Port of siguienteManifiesto(). */
export function siguienteManifiesto(exec: Queryable = db()): Promise<string> {
  return siguienteConsecutivo(exec, 'consecutivo_manifiesto', 'MAN');
}
