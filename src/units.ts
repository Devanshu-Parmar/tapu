/** Unit tables for the converter. Each unit's number is how many base units it equals. */
export interface UnitGroup {
  name: string;
  /** unit label -> size in the group's base unit. Empty for temperature, which is not a simple ratio. */
  units: Record<string, number>;
}

export const GROUPS: UnitGroup[] = [
  { name: 'Length', units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, inch: 0.0254, foot: 0.3048, yard: 0.9144, mile: 1609.344 } },
  { name: 'Weight', units: { mg: 1e-6, g: 0.001, kg: 1, tonne: 1000, ounce: 0.028349523125, pound: 0.45359237 } },
  { name: 'Temperature', units: { '°C': 0, '°F': 0, K: 0 } },
  { name: 'Area', units: { 'cm²': 1e-4, 'm²': 1, 'km²': 1e6, hectare: 1e4, 'ft²': 0.09290304, acre: 4046.8564224 } },
  { name: 'Volume', units: { ml: 0.001, litre: 1, 'm³': 1000, teaspoon: 0.00492892159375, tablespoon: 0.01478676478125, cup: 0.2365882365, 'gallon (US)': 3.785411784 } },
  { name: 'Speed', units: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, knot: 1852 / 3600 } },
  { name: 'Time', units: { ms: 0.001, second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 } },
  { name: 'Data', units: { byte: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824 } },
  { name: 'Pressure', units: { Pa: 1, kPa: 1000, bar: 1e5, psi: 6894.757293168, atm: 101325 } },
  { name: 'Energy', units: { J: 1, kJ: 1000, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3.6e6 } },
  { name: 'Power', units: { W: 1, kW: 1000, hp: 745.6998715823 } },
  { name: 'Angle', units: { degree: 1, radian: 180 / Math.PI, turn: 360 } },
];

function toCelsius(v: number, unit: string) {
  if (unit === '°F') return (v - 32) * 5 / 9;
  if (unit === 'K') return v - 273.15;
  return v;
}
function fromCelsius(c: number, unit: string) {
  if (unit === '°F') return c * 9 / 5 + 32;
  if (unit === 'K') return c + 273.15;
  return c;
}

export function convert(group: UnitGroup, value: number, from: string, to: string): number {
  if (group.name === 'Temperature') return fromCelsius(toCelsius(value, from), to);
  return value * group.units[from] / group.units[to];
}

/** Up to 6 significant digits, without trailing zeros or exponent noise for everyday sizes. */
export function pretty(n: number): string {
  if (!isFinite(n)) return '';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9 || abs < 1e-6) return n.toExponential(4);
  return String(Number(n.toPrecision(6)));
}
