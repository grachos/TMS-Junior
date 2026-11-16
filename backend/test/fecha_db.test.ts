import { describe, expect, it } from 'vitest';
import { fechaDb } from '../../frontend/src/lib/fechaDb';

describe('fechas de la base (sin zona = UTC)', () => {
  it('una fecha de la base se lee como UTC, igual que su equivalente ISO', () => {
    expect(fechaDb('2026-11-16 00:01:02').toISOString()).toBe('2026-11-16T00:01:02.000Z');
    expect(fechaDb('2026-11-16T00:01:02').toISOString()).toBe('2026-11-16T00:01:02.000Z');
    expect(fechaDb('2026-11-16 00:01').toISOString()).toBe('2026-11-16T00:01:00.000Z');
  });
  it('si ya trae zona se respeta', () => {
    expect(fechaDb('2026-11-16T00:01:02.000Z').toISOString()).toBe('2026-11-16T00:01:02.000Z');
    expect(fechaDb('2026-11-15T19:01:02-05:00').toISOString()).toBe('2026-11-16T00:01:02.000Z');
  });
});
