/**
 * Light TMS - Cliente del proveedor de IA para el soporte del propietario (fase 3c).
 * Sin herramientas (`tools`): el modelo solo recibe texto sanitizado y devuelve texto. Es un módulo APARTE del chat de datos:
 * nada de aquí se registra en el registro de herramientas del chat.
 * El proveedor se puede sustituir (pruebas) con `usarProveedorIa`.
 */
import { config } from '../../config/env.js';

export type ProveedorIa = (sistema: string, usuario: string) => Promise<{ texto: string; modelo: string }>;

const real: ProveedorIa = async (sistema, usuario) => {
  const c = config();
  const modelo = c.soporteIa.modelo || c.chat.modelo;
  const resp = await fetch(`${c.chat.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.chat.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Konekto soporte' },
    body: JSON.stringify({ model: modelo, messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }], temperature: 0.2, max_tokens: 700 }),
    signal: AbortSignal.timeout(45_000),
  });
  // El cuerpo del error NO se propaga (podría repetir parte de lo enviado).
  if (!resp.ok) throw new Error(`Proveedor de IA HTTP ${resp.status}`);
  const data = (await resp.json()) as { choices?: { message?: { content?: unknown } }[] };
  const t = data.choices?.[0]?.message?.content;
  if (typeof t !== 'string' || !t.trim()) throw new Error('Proveedor de IA: respuesta vacía');
  return { texto: t, modelo };
};

let actual: ProveedorIa = real;
export const llamarProveedorIa: ProveedorIa = (s, u) => actual(s, u);
/** Solo pruebas. Sin argumento restablece el proveedor real. */
export function usarProveedorIa(p?: ProveedorIa): void { actual = p ?? real; }
