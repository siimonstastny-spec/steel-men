// Steel Men – hover highlight of whole units (mech, vehicle, building) – SIT
// Mechs highlight all their parts (MechPart owns its cloned materials). Vehicles and buildings may share materials
// with other instances, so a highlighted mesh gets a private material clone that is swapped back on release –
// the shared material itself is never touched (otherwise every unit sharing it would stay lit).
import { HIGHLIGHT } from '../config.js';

const ORIGINAL = 'highlightOriginal';

/** Sets the hover glow of a whole unit. Safe to call repeatedly and with null. */
export function setUnitHighlight(unit, on) {
  if (!unit) return;
  unit.procModel?.setHighlighted?.(on); // [18P] batched procedural body: instance attribute (other meshes continue below)
  if (unit.procModel?.isProcUnit) return; // procedural units: highlight is the instance attribute only (no material clones)
  if (unit.parts) { // mech
    for (const part of Object.values(unit.parts)) part?.setHighlighted(on);
    return;
  }
  unit.model?.traverse((o) => { if (o.isMesh) setMeshGlow(o, on); });
}

function setMeshGlow(mesh, on) {
  if (on) {
    if (mesh.userData[ORIGINAL]) return;
    mesh.userData[ORIGINAL] = mesh.material;
    const glow = (m) => {
      const c = m.clone();
      if (c.emissive) { c.emissive.set(HIGHLIGHT.color); c.emissiveIntensity = HIGHLIGHT.intensity; }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(glow) : glow(mesh.material);
  } else if (mesh.userData[ORIGINAL]) {
    const clones = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.material = mesh.userData[ORIGINAL];
    delete mesh.userData[ORIGINAL];
    for (const m of clones) m.dispose();
  }
}
