// Einfache Physik-Prüfung: Passt das Gewicht zu den Maßen?
// Dichte = Gewicht / Volumen. Referenzwerte:
//   Blei  ≈ 11,34 g/cm³  (schwerer ist für normale Gegenstände unplausibel)
//   Helium ≈ 0,0001786 g/cm³ (leichter ist praktisch nur ein Vakuum-Ballon)

export const LEAD_DENSITY_G_CM3 = 11.34;
export const HELIUM_DENSITY_G_CM3 = 0.0001786;

const round = (n, digits = 2) => Number(n.toFixed(digits));
const formatDensity = (n) => (n >= 0.01 ? round(n, 2) : Number(n.toPrecision(2)));

function itemVolumeCm3(item) {
  const d = item?.dims_cm ?? {};
  const dims = [d.length_cm, d.width_cm, d.height_cm].map(Number);
  if (dims.every((n) => Number.isFinite(n) && n > 0)) {
    return dims[0] * dims[1] * dims[2];
  }
  const liters = Number(item?.volume_liters);
  return Number.isFinite(liters) && liters > 0 ? liters * 1000 : null;
}

/**
 * Findet Gegenstände, deren Dichte physikalisch unplausibel ist.
 * @returns {Array<{type,severity,item_id,message,signature,density_g_cm3,volume_cm3,weight_g,item}>}
 */
export function findPlausibilityIssues(items, {
  leadDensity = LEAD_DENSITY_G_CM3,
  heliumDensity = HELIUM_DENSITY_G_CM3,
} = {}) {
  const issues = [];
  for (const item of items ?? []) {
    const weight = Number(item?.weight_g);
    const volume = itemVolumeCm3(item);
    if (!Number.isFinite(weight) || weight <= 0 || !volume) continue;
    const density = weight / volume;
    if (density <= leadDensity && density >= heliumDensity) continue;

    const d = item.dims_cm ?? {};
    const high = density > leadDensity;
    issues.push({
      type: high ? 'density_high' : 'density_low',
      severity: 'high',
      item_id: item.id,
      signature: `density:${high ? 'high' : 'low'}:${item.id}:${round(density, 4)}`,
      message: high
        ? `Dichte ${formatDensity(density)} g/cm³ – schwerer als Blei (11,34 g/cm³). Maße zu klein oder Gewicht zu hoch?`
        : `Dichte ${formatDensity(density)} g/cm³ – leichter als Helium (0,0001786 g/cm³). Maße zu groß oder Gewicht zu niedrig?`,
      density_g_cm3: round(density, 4),
      volume_cm3: round(volume),
      weight_g: weight,
      item: {
        id: item.id,
        name: item.name,
        weight_g: item.weight_g,
        dims_cm: d.length_cm ? { length_cm: d.length_cm, width_cm: d.width_cm, height_cm: d.height_cm } : null,
        bin: item.bin ? { id: item.bin.id, code: item.bin.code, name: item.bin.name } : null,
      },
    });
  }
  return issues;
}
