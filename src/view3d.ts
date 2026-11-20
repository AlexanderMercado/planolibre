// Vista 3D: levanta los muros del plano con sus vanos, pisos y mobiliario.
// Se carga sólo al entrar al modo 3D (three.js es pesado).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Project, Pt } from './core/model';
import { computeRooms, openingFrames, wallGeoms, wallPieces } from './core/topology';
import { symbolDef } from './core/symbols';
import { roomColor } from './core/themes';

export class View3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private group = new THREE.Group();
  private sun: THREE.DirectionalLight;
  private ro: ResizeObserver;
  private framed = false;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#e9edf2');
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe6e1d8, 1.5), new THREE.AmbientLight(0xffffff, 0.55));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target, this.group);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
  }

  resize() {
    const w = Math.max(50, this.el.clientWidth), h = Math.max(50, this.el.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  private clear() {
    this.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.group.clear();
  }

  private extrude(poly: Pt[], base: number, height: number, mat: THREE.Material | THREE.Material[], shadow = true): THREE.Mesh | null {
    if (poly.length < 3 || height <= 0.001) return null;
    const sh = new THREE.Shape(poly.map(p => new THREE.Vector2(p.x, -p.y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: height, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.y = base;
    m.castShadow = shadow; m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  build(project: Project) {
    this.clear();
    const wallSide = new THREE.MeshStandardMaterial({ color: '#f6f3ee', roughness: 0.95 });
    const wallTop = new THREE.MeshStandardMaterial({ color: '#3c4350', roughness: 1 });
    const wallMats = [wallTop, wallSide];
    const glass = new THREE.MeshStandardMaterial({ color: '#9fd3f2', transparent: true, opacity: 0.38, roughness: 0.1 });
    const furn = new THREE.MeshStandardMaterial({ color: '#d9cdb8', roughness: 0.9 });
    const soft = new THREE.MeshStandardMaterial({ color: '#8fa3b8', roughness: 1 });
    const white = new THREE.MeshStandardMaterial({ color: '#fafafa', roughness: 0.5 });
    const green = new THREE.MeshStandardMaterial({ color: '#6aa56a', roughness: 1 });
    const wood = new THREE.MeshStandardMaterial({ color: '#b08d62', roughness: 0.9 });

    const box = new THREE.Box3();
    let any = false;
    for (const level of project.levels) {
      const y0 = level.elevation;
      const geoms = wallGeoms(level), frames = openingFrames(level, geoms);
      for (const p of wallPieces(geoms, frames)) for (const f of p.fills) this.extrude(f, y0, p.g.wall.height, wallMats);
      for (const f of frames) {
        const n = { x: f.g.nrm.x * f.thick / 2, y: f.g.nrm.y * f.thick / 2 };
        const quad = [{ x: f.p0.x + n.x, y: f.p0.y + n.y }, { x: f.p1.x + n.x, y: f.p1.y + n.y }, { x: f.p1.x - n.x, y: f.p1.y - n.y }, { x: f.p0.x - n.x, y: f.p0.y - n.y }];
        const H = f.g.wall.height, top = Math.min(H, f.o.sill + f.o.height);
        if (f.o.kind === 'window' && f.o.sill > 0.01) this.extrude(quad, y0, Math.min(f.o.sill, H), wallMats);
        if (top < H - 0.01) this.extrude(quad, y0 + top, H - top, wallMats);
        if (f.o.kind === 'window') {
          const t = { x: f.g.nrm.x * 0.015, y: f.g.nrm.y * 0.015 };
          const pane = [{ x: f.p0.x + t.x, y: f.p0.y + t.y }, { x: f.p1.x + t.x, y: f.p1.y + t.y }, { x: f.p1.x - t.x, y: f.p1.y - t.y }, { x: f.p0.x - t.x, y: f.p0.y - t.y }];
          this.extrude(pane, y0 + f.o.sill, top - f.o.sill, glass, false);
        }
      }
      for (const r of computeRooms(level)) {
        const m = this.extrude(r.poly, y0 - 0.05, 0.05, new THREE.MeshStandardMaterial({ color: roomColor(r.meta?.type || 'other'), roughness: 1 }), false);
        if (m) m.receiveShadow = true;
      }
      for (const it of level.items) {
        const def = symbolDef(it.type);
        if (def.z <= 0) continue;
        const rot = (-it.rot * Math.PI) / 180;
        let mesh: THREE.Mesh;
        if (it.type === 'tree' || it.type === 'plant') {
          const r = Math.min(it.w, it.h) / 2;
          mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), green);
          mesh.position.set(it.x, y0 + def.z - r, it.y);
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.16, Math.max(0.05, def.z - r), 10), wood);
          trunk.position.set(it.x, y0 + (def.z - r) / 2, it.y); trunk.castShadow = true;
          this.group.add(trunk);
        } else if (it.type === 'columnR' || it.type === 'tableR') {
          const r = Math.min(it.w, it.h) / 2 * (it.type === 'tableR' ? 0.62 : 1);
          mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, def.z, 28), it.type === 'tableR' ? wood : white);
          mesh.position.set(it.x, y0 + def.z / 2, it.y);
        } else {
          const cat = def.cat;
          const mat = it.type === 'rug' ? soft : it.type === 'pool' ? glass : cat === 'Baño' || it.type === 'fridge' || it.type === 'washer' || it.type === 'stove' ? white
            : /sofa|armchair|bed|chair/i.test(it.type) ? soft : cat === 'Estructura y exterior' ? white : furn;
          mesh = new THREE.Mesh(new THREE.BoxGeometry(it.w, def.z, it.h), mat);
          mesh.position.set(it.x, y0 + def.z / 2, it.y);
          mesh.rotation.y = rot;
        }
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      for (const g of geoms.values()) {
        any = true;
        box.expandByPoint(new THREE.Vector3(g.a.x, y0, g.a.y)); box.expandByPoint(new THREE.Vector3(g.b.x, y0 + g.wall.height, g.b.y));
      }
      for (const it of level.items) { any = true; box.expandByPoint(new THREE.Vector3(it.x, y0, it.y)); }
    }
    if (!any) box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2.4, 2));
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 4);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), new THREE.MeshStandardMaterial({ color: '#dfe4ea', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(c.x, box.min.y - 0.06, c.z); ground.receiveShadow = true;
    this.group.add(ground);

    this.sun.position.set(c.x + span * 0.7, box.max.y + span * 1.4, c.z + span * 0.5);
    this.sun.target.position.copy(c);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.1; sc.far = span * 6;
    sc.updateProjectionMatrix();

    if (!this.framed) {
      this.camera.position.set(c.x + span * 0.55, box.max.y + span * 0.95, c.z + span * 1.05);
      this.controls.target.set(c.x, box.min.y + size.y * 0.3, c.z);
      this.controls.update();
      this.framed = true;
    }
    this.render();
  }

  resetCamera() { this.framed = false; }
  snapshot(): string { this.render(); return this.renderer.domElement.toDataURL('image/png'); }

  dispose() {
    this.ro.disconnect();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
