import * as THREE from "three";
import { C100_MANIFEST } from "./vehicles/c100Manifest.js";

const HEIGHT = C100_MANIFEST.geometry.height.value;
const RADIUS = C100_MANIFEST.geometry.diameter.value * 0.5;
const GORE_COUNT = C100_MANIFEST.geometry.gores.value;

function radiusAt(t) {
  return RADIUS * Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.9) * (0.92 + 0.08 * t);
}

function envelopeGeometry() {
  const verticalSegments = 24;
  const positions = [];
  const uvs = [];
  const indices = [];
  const geometry = new THREE.BufferGeometry();
  for (let y = 0; y <= verticalSegments; y++) {
    const t = y / verticalSegments;
    const radius = radiusAt(t);
    const py = (t - 0.5) * HEIGHT;
    for (let gore = 0; gore <= GORE_COUNT; gore++) {
      const angle = gore / GORE_COUNT * Math.PI * 2;
      positions.push(Math.sin(angle) * radius, py, Math.cos(angle) * radius);
      uvs.push(gore / GORE_COUNT, t);
    }
  }
  for (let y = 0; y < verticalSegments; y++) {
    for (let gore = 0; gore < GORE_COUNT; gore++) {
      const a = y * (GORE_COUNT + 1) + gore;
      const b = a + GORE_COUNT + 1;
      const start = indices.length;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
      geometry.addGroup(start, 6, gore % 4);
    }
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function tubeBetween(a, b, radius, material, radialSegments = 6) {
  const curve = new THREE.LineCurve3(a, b);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 1, radius, radialSegments, false), material);
}

function curvedTube(points, radius, material) {
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, radius, 5, false), material);
}

function buildBasket(wicker, dark, metal, tankMaterial) {
  const group = new THREE.Group();
  const width = 1.75, depth = 1.35, height = 1.28;
  const wallGeo = new THREE.BoxGeometry(width, height, 0.12);
  const front = new THREE.Mesh(wallGeo, wicker);
  front.position.set(0, 0, depth / 2);
  const back = front.clone(); back.position.z = -depth / 2;
  const sideGeo = new THREE.BoxGeometry(0.12, height, depth);
  const left = new THREE.Mesh(sideGeo, wicker); left.position.x = -width / 2;
  const right = left.clone(); right.position.x = width / 2;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.14, depth), dark); floor.position.y = -height / 2;
  group.add(front, back, left, right, floor);
  for (let i = -3; i <= 3; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.035, height * 0.94, 0.145), dark);
    strip.position.set(i * width / 7, 0, depth / 2 + 0.01);
    group.add(strip);
    const stripBack = strip.clone(); stripBack.position.z = -depth / 2 - 0.01; group.add(stripBack);
  }
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 8, 32), dark);
  rim.scale.z = depth / width;
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height / 2;
  group.add(rim);

  const frame = new THREE.Group();
  const framePoints = [
    [-0.7, 0.58, -0.48], [0.7, 0.58, -0.48], [-0.7, 0.58, 0.48], [0.7, 0.58, 0.48]
  ];
  framePoints.forEach(([x, y, z]) => frame.add(tubeBetween(
    new THREE.Vector3(x, y, z), new THREE.Vector3(x * 0.85, y + 2.05, z * 0.84), 0.055, metal
  )));
  frame.add(tubeBetween(new THREE.Vector3(-0.65, 2.58, 0), new THREE.Vector3(0.65, 2.58, 0), 0.07, metal));
  group.add(frame);

  const burners = [];
  for (const x of [-0.31, 0.31]) {
    const burner = new THREE.Group();
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.44, 18), metal);
    can.position.y = 2.55;
    const rimMesh = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 6, 18), dark);
    rimMesh.rotation.x = Math.PI / 2; rimMesh.position.y = 2.78;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.19, 1.5, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0xffb137, transparent: true, opacity: 0.88, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.position.y = 3.55;
    flame.visible = false;
    burner.position.x = x;
    burner.add(can, rimMesh, flame);
    burner.userData.flame = flame;
    burners.push(burner);
    group.add(burner);
  }

  const tanks = [];
  for (const x of [-0.55, 0.55]) {
    const tank = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.92, 20), tankMaterial);
    body.position.y = -0.03;
    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.17, 12), metal);
    valve.position.y = 0.51;
    tank.position.set(x, 0.05, -0.42);
    tank.add(body, valve);
    tanks.push(tank);
    group.add(tank);
  }
  const hoseMaterial = new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.72 });
  group.add(
    curvedTube([new THREE.Vector3(-0.55, 0.56, -0.42), new THREE.Vector3(-0.45, 1.5, -0.25), new THREE.Vector3(-0.31, 2.38, 0)], 0.025, hoseMaterial),
    curvedTube([new THREE.Vector3(0.55, 0.56, -0.42), new THREE.Vector3(0.45, 1.5, -0.25), new THREE.Vector3(0.31, 2.38, 0)], 0.025, hoseMaterial)
  );

  const burnerHandle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 7, 20, Math.PI * 1.5), new THREE.MeshStandardMaterial({ color: 0xeba92e, metalness: 0.5, roughness: 0.34 }));
  burnerHandle.rotation.set(Math.PI / 2, 0, Math.PI / 4);
  burnerHandle.position.set(0, 2.2, 0.28);
  burnerHandle.userData.action = "burner";
  group.add(burnerHandle);
  const ventHandle = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.03, 7, 20), new THREE.MeshStandardMaterial({ color: 0xc72436, roughness: 0.42 }));
  ventHandle.rotation.x = Math.PI / 2;
  ventHandle.position.set(0.62, 1.85, 0.34);
  ventHandle.userData.action = "vent";
  group.add(ventHandle);

  return { group, burners, tanks, controls: [burnerHandle, ventHandle] };
}

export function createBalloonModel() {
  const root = new THREE.Group();
  root.name = "FLY-C100";
  const blue = [0x0873c9, 0x1499dd, 0xe8f7ff, 0x095ca5].map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.73, side: THREE.DoubleSide }));
  const tapeMaterial = new THREE.MeshStandardMaterial({ color: 0xf0ead9, roughness: 0.65 });
  const nomex = new THREE.MeshStandardMaterial({ color: 0x242728, roughness: 0.92, side: THREE.DoubleSide });
  const wicker = new THREE.MeshStandardMaterial({ color: 0x9b6a35, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b281a, roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9eabb3, metalness: 0.82, roughness: 0.26 });
  const tankMaterial = new THREE.MeshStandardMaterial({ color: 0xb5bdc2, metalness: 0.62, roughness: 0.3 });

  const envelopeGroup = new THREE.Group();
  envelopeGroup.name = "C100-envelope-body";
  const envelope = new THREE.Mesh(envelopeGeometry(), blue);
  envelope.name = "C100-16-gore-envelope";
  envelopeGroup.add(envelope);
  for (let gore = 0; gore < GORE_COUNT; gore++) {
    const angle = gore / GORE_COUNT * Math.PI * 2;
    const points = [];
    for (let ring = 1; ring < 24; ring++) {
      const t = ring / 24;
      const radius = radiusAt(t) + 0.025;
      points.push(new THREE.Vector3(Math.sin(angle) * radius, (t - 0.5) * HEIGHT, Math.cos(angle) * radius));
    }
    envelopeGroup.add(curvedTube(points, 0.035, tapeMaterial));
  }
  for (const t of [0.24, 0.48, 0.72]) {
    const tape = new THREE.Mesh(new THREE.TorusGeometry(radiusAt(t), 0.035, 5, 64), tapeMaterial);
    tape.rotation.x = Math.PI / 2;
    tape.position.y = (t - 0.5) * HEIGHT;
    envelopeGroup.add(tape);
  }
  const mouth = new THREE.Mesh(new THREE.CylinderGeometry(radiusAt(0.11), 1.15, 2.15, GORE_COUNT, 1, true), nomex);
  mouth.position.y = -HEIGHT / 2 + 1.05;
  envelopeGroup.add(mouth);
  const vent = new THREE.Mesh(new THREE.CircleGeometry(1.75, 32), new THREE.MeshStandardMaterial({ color: 0x0c5f9d, roughness: 0.78, side: THREE.DoubleSide }));
  vent.rotation.x = -Math.PI / 2;
  vent.position.y = HEIGHT / 2 - 0.08;
  vent.name = "C100-parachute-deflation-vent";
  envelopeGroup.add(vent);
  root.add(envelopeGroup);

  const basketSystem = buildBasket(wicker, dark, metal, tankMaterial);
  const basketGroup = basketSystem.group;
  basketGroup.name = "C100-basket-frame-fuel-system";
  root.add(basketGroup);

  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xe8e1cb });
  const suspensionGeometry = new THREE.BufferGeometry();
  suspensionGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
  const suspension = new THREE.LineSegments(suspensionGeometry, lineMaterial);
  suspension.name = "C100-load-lines";
  root.add(suspension);
  const ventLineGeometry = new THREE.BufferGeometry();
  ventLineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 3), 3));
  const ventLine = new THREE.Line(ventLineGeometry, new THREE.LineBasicMaterial({ color: 0xc92d3e }));
  ventLine.name = "C100-deflation-line";
  root.add(ventLine);

  const syncLines = () => {
    const e = envelopeGroup.position, b = basketGroup.position;
    const scale = envelopeGroup.scale;
    const line = suspensionGeometry.attributes.position.array;
    const anchors = [[-1.2, -8.2, -0.75], [1.2, -8.2, -0.75], [-1.2, -8.2, 0.75], [1.2, -8.2, 0.75]];
    const basketAnchors = [[-0.72, 2.55, -0.48], [0.72, 2.55, -0.48], [-0.72, 2.55, 0.48], [0.72, 2.55, 0.48]];
    for (let i = 0; i < 4; i++) {
      const offset = i * 6;
      line[offset] = e.x + anchors[i][0] * scale.x;
      line[offset + 1] = e.y + anchors[i][1] * scale.y;
      line[offset + 2] = e.z + anchors[i][2] * scale.z;
      line[offset + 3] = b.x + basketAnchors[i][0]; line[offset + 4] = b.y + basketAnchors[i][1]; line[offset + 5] = b.z + basketAnchors[i][2];
    }
    suspensionGeometry.attributes.position.needsUpdate = true;
    const rope = ventLineGeometry.attributes.position.array;
    rope.set([
      e.x, e.y + (HEIGHT / 2 - 0.1) * scale.y, e.z,
      e.x + 0.6 * scale.x, e.y - HEIGHT * 0.18 * scale.y, e.z + 0.2 * scale.z,
      b.x + 0.62, b.y + 1.85, b.z + 0.34
    ]);
    ventLineGeometry.attributes.position.needsUpdate = true;
  };

  const update = (snapshot, origin = { x: 0, y: 0, z: 0 }) => {
    const e = snapshot.envelope.position, b = snapshot.basket.position;
    const recovered = snapshot.stage === "RECOVERED";
    envelopeGroup.position.set(
      (recovered ? b.x + 8 : e.x) - origin.x,
      (recovered ? b.y + 0.75 : e.y) - origin.y,
      (recovered ? b.z : e.z) - origin.z
    );
    envelopeGroup.scale.set(recovered ? 0.72 : 1, recovered ? 0.12 : 1, recovered ? 0.72 : 1);
    basketGroup.position.set(b.x - origin.x, b.y - origin.y, b.z - origin.z);
    basketGroup.rotation.set(snapshot.basket.tilt.x, 0, snapshot.basket.tilt.z);
    basketSystem.burners.forEach(burner => {
      const flame = burner.userData.flame;
      flame.visible = snapshot.heatInputW > 1;
      flame.scale.y = 0.3 + snapshot.burnerValve * 0.7;
      flame.material.opacity = 0.55 + snapshot.burnerValve * 0.35;
    });
    envelope.scale.setScalar(1);
    envelope.position.set(0, 0, 0);
    syncLines();
  };

  const dispose = () => {
    const geometries = new Set(), materials = new Set();
    root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach(material => materials.add(material));
      else if (object.material) materials.add(object.material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  };

  return { group: root, envelopeGroup, basketGroup, controlMeshes: basketSystem.controls, update, syncLines, dispose };
}
