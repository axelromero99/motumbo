// Live tunables for feel (camera + face). The dev panel (backtick) writes here,
// the renderer reads here, and it all persists to localStorage — so you can dial
// in the feel while playing instead of round-tripping through code + rebuild.
export interface TuneParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
}

export const TUNE_PARAMS: TuneParam[] = [
  { key: 'isoH', label: 'Cám. iso · altura', min: 1.0, max: 2.6, step: 0.02, def: 1.78 },
  { key: 'isoD', label: 'Cám. iso · distancia', min: 1.0, max: 2.6, step: 0.02, def: 1.66 },
  { key: 'topH', label: 'Cám. arriba · altura', min: 0.5, max: 1.8, step: 0.02, def: 0.95 },
  { key: 'tpBack', label: '3ra pers. · atrás', min: 3, max: 12, step: 0.2, def: 6.6 },
  { key: 'tpHigh', label: '3ra pers. · altura', min: 1, max: 8, step: 0.2, def: 3.7 },
  { key: 'facePitch', label: 'Cara · inclinación', min: -0.5, max: 0.25, step: 0.02, def: -0.1 },
  { key: 'eyeSz', label: 'Ojos · tamaño', min: 0.16, max: 0.4, step: 0.01, def: 0.26 },
];

const KEY = 'motumbo.tune';

export function loadTune(): Record<string, number> {
  try {
    return { ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, number>) };
  } catch {
    return {};
  }
}

export function saveTune(t: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    // ignore storage errors
  }
}

/** Current value for a key, falling back to the param's default. */
export function tuneVal(t: Record<string, number>, key: string): number {
  const v = t[key];
  if (v !== undefined && !Number.isNaN(v)) return v;
  return TUNE_PARAMS.find((p) => p.key === key)?.def ?? 0;
}
