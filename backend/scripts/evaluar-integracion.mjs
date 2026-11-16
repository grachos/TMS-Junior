#!/usr/bin/env node
/**
 * Evalúa la política de integración (fase 5) con el módulo YA COMPILADO de `main`. Uso:
 *   node scripts/evaluar-integracion.mjs <politica.json> <entrada.json>
 * Imprime la decisión en JSON. Cualquier fallo (archivo ausente, JSON roto, política inválida) = NO integrar.
 */
import { readFileSync } from 'node:fs';
import { decidir, validarPolitica } from '../dist/modules/agente/politicaIntegracion.js';

const [rutaPolitica, rutaEntrada] = process.argv.slice(2);
let decision;
try {
  const politica = JSON.parse(readFileSync(rutaPolitica, 'utf8'));
  if (!validarPolitica(politica)) throw new Error('política inválida');
  decision = decidir(politica, JSON.parse(readFileSync(rutaEntrada, 'utf8')));
} catch {
  decision = { accion: 'no', elegible: false, motivos: ['No se pudo evaluar (política o datos inválidos).'] };
}
console.log(JSON.stringify(decision));
