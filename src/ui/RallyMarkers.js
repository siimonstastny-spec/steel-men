// Steel Men – rally point of the selected own building: a line from the building through the chain of rally
// points, a ring at each point and a pole on the last one. Only the owner sees it, and only while the building is
// selected. Visual only (reads structure.rally, never touches the simulation). Sizes / colours: RALLY.marker (config.js).
// Wiring (main.js): const rallyMarkers = new RallyMarkers({ world, input }); call rallyMarkers.update() every frame.
import * as THREE from 'three';
import { RALLY } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';

export class RallyMarkers {
  /** @param {{ world, input }} deps  World (scene, heightAt) and CommandInput (selection) */
  constructor({ world, input }) {
    this.world = world;
    this.input = input;
    const m = RALLY.marker;
    this.max = m.maxPoints;
    this.color = new THREE.Color(m.color);
    this.maxSegments = m.maxSegments;
    this.positions = new Float32Array(this.maxSegments * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: m.color, transparent: true, opacity: m.opacity, depthWrite: false,
      depthTest: false, // the leg from the building must stay visible through the building mesh and terrain bumps
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    const ring = new THREE.RingGeometry(m.ringRadius - m.ringWidth, m.ringRadius, m.ringSegments).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({
      color: m.color, transparent: true, opacity: m.opacity, depthWrite: false, side: THREE.DoubleSide,
    }), this.max);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 1;
    this.rings.count = 0;
    this._m = new THREE.Matrix4();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  #attach() {
    if (this.lines.parent || !this.world.scene) return;
    this.world.scene.add(this.lines, this.rings);
  }

  update() {
    this.#attach();
    const m = RALLY.marker;
    const s = this.input.selectedStructure;
    const points = s && isLocal(s) && !s.destroyed && s.rally?.length ? s.rally : [];
    const ground = (p, lift, out) => out.set(p.x, (this.world.heightAt?.(p.x, p.z) ?? 0) + lift, p.z);
    let seg = 0;
    let rings = 0;
    const addSeg = (a, b) => {
      if (seg >= this.maxSegments) return;
      a.toArray(this.positions, seg * 6);
      b.toArray(this.positions, seg * 6 + 3);
      seg++;
    };
    // A long leg is cut into short pieces that follow the terrain (a straight line would dive under hills).
    const addLeg = (a, b) => {
      const pieces = Math.max(1, Math.ceil(a.distanceTo(b) / m.legStep));
      let prev = a;
      for (let i = 1; i <= pieces; i++) {
        const k = i / pieces;
        const x = a.x + (b.x - a.x) * k;
        const z = a.z + (b.z - a.z) * k;
        const next = i === pieces ? b : ground({ x, z }, m.height, new THREE.Vector3());
        addSeg(prev, next);
        prev = next;
      }
    };
    if (points.length) {
      let from = ground(s.position, m.height, new THREE.Vector3());
      for (const p of points) {
        const to = ground(p, m.height, new THREE.Vector3());
        addLeg(from, to);
        if (rings < this.max) this.rings.setMatrixAt(rings++, this._m.makeTranslation(to.x, to.y, to.z));
        from = to;
      }
      addSeg(from, this._b.copy(from).setY(from.y + m.poleHeight)); // pole on the last point
    }
    const geo = this.lines.geometry;
    geo.setDrawRange(0, seg * 2);
    geo.attributes.position.needsUpdate = true;
    this.lines.visible = seg > 0;
    this.rings.count = rings;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.visible = rings > 0;
  }
}
