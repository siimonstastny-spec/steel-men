// Steel Men – order queue on the ground: for every selected own unit with queued orders (OrderQueue.js) a line
// runs from the unit through the targets of its current and queued orders, with a ring at each target.
// A patrol is drawn as a closed loop in its own colour. Colours / sizes: ORDER_QUEUE.marker (config.js).
import * as THREE from 'three';
import { ORDER_QUEUE } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';
import { orderTargets } from '../units/OrderQueue.js';

export class OrderQueueMarkers {
  /** @param {{ world, input }} deps  World (scene, heightAt) and CommandInput (selection) */
  constructor({ world, input }) {
    this.world = world;
    this.input = input;
    const m = ORDER_QUEUE.marker;
    this.max = m.maxPoints;
    // Line segments with per-vertex colours (normal queue / patrol)
    this.positions = new Float32Array(this.max * 2 * 3);
    this.colors = new Float32Array(this.max * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: m.opacity, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 1;
    // One ring per target
    const ring = new THREE.RingGeometry(m.ringRadius - m.ringWidth, m.ringRadius, m.ringSegments).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({
      transparent: true, opacity: m.opacity, depthWrite: false, side: THREE.DoubleSide,
    }), this.max);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 1;
    this.rings.count = 0;
    this.colorQueue = new THREE.Color(m.color);
    this.colorPatrol = new THREE.Color(m.patrolColor);
    this._m = new THREE.Matrix4();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  /** Puts the markers into the world scene (once the scene exists) */
  #attach() {
    if (this.lines.parent || !this.world.scene) return;
    this.world.scene.add(this.lines, this.rings);
  }

  update() {
    this.#attach();
    let seg = 0;
    let rings = 0;
    const lift = ORDER_QUEUE.marker.height;
    const ground = (p, out) => out.set(p.x, (this.world.heightAt?.(p.x, p.z) ?? 0) + lift, p.z);
    const addSeg = (from, to, color) => {
      if (seg >= this.max) return;
      ground(from, this._a).toArray(this.positions, seg * 6);
      ground(to, this._b).toArray(this.positions, seg * 6 + 3);
      color.toArray(this.colors, seg * 6);
      color.toArray(this.colors, seg * 6 + 3);
      seg++;
    };
    const addRing = (p, color) => {
      if (rings >= this.max) return;
      this.rings.setMatrixAt(rings, this._m.makeTranslation(ground(p, this._a)));
      this.rings.setColorAt(rings, color);
      rings++;
    };

    for (const unit of this.input.selection) {
      if (!isLocal(unit) || !unit.orderQueue?.length) continue;
      let from = unit.position;
      for (const { type, points } of orderTargets(unit)) {
        const color = type === 'patrol' ? this.colorPatrol : this.colorQueue;
        for (const p of points) { addSeg(from, p, color); addRing(p, color); from = p; }
        if (type === 'patrol' && points.length > 1) addSeg(points.at(-1), points[0], color); // the loop closes
      }
    }

    const geo = this.lines.geometry;
    geo.setDrawRange(0, seg * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    this.lines.visible = seg > 0;
    this.rings.count = rings;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.rings.visible = rings > 0;
  }
}
