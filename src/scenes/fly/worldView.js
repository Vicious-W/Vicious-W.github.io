import * as THREE from "three";
import { CHUNK_SIZE_M } from "./world/proceduralWorld.js";

const SURFACE_COLORS = {
  FIELD: new THREE.Color(0x527d31),
  FOREST: new THREE.Color(0x214c2b),
  ROAD: new THREE.Color(0x77756a),
  WATER: new THREE.Color(0x176f9e)
};

function makeSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x126fc2) },
      horizonColor: { value: new THREE.Color(0xb7dded) },
      groundColor: { value: new THREE.Color(0x8496a0) },
      sunDirection: { value: new THREE.Vector3(-0.35, 0.72, -0.42).normalize() }
    },
    vertexShader: `varying vec3 vDir; void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform vec3 sunDirection;
      void main(){
        float h=smoothstep(-0.16,0.62,vDir.y);
        vec3 col=mix(groundColor,mix(horizonColor,topColor,smoothstep(0.02,0.72,vDir.y)),smoothstep(-0.2,0.02,vDir.y));
        float sun=pow(max(dot(vDir,sunDirection),0.0),420.0);
        col+=vec3(1.0,0.72,0.36)*sun*3.0;
        gl_FragColor=vec4(col,1.0);
      }`
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 18), material);
}

export function createWorldView({ scene, world, atmosphere }) {
  const group = new THREE.Group();
  group.name = "FLY-procedural-world";
  scene.add(group);
  const terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const chunkMeshes = new Map();
  let chunkSignature = "";
  let originSignature = "";

  const sky = makeSky();
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffefd2, 3.7);
  sun.position.set(-240, 470, -310);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xccecff, 0x44502d, 1.65));
  scene.fog = new THREE.FogExp2(0xa5c7d5, 0.00135);

  const cloudGroup = new THREE.Group();
  const cloudGeo = new THREE.IcosahedronGeometry(1, 2);
  const cloudMaterial = new THREE.MeshPhysicalMaterial({ color: 0xf2f7fa, transparent: true, opacity: 0.34, roughness: 1, depthWrite: false });
  atmosphere.thermals.slice(0, 10).forEach((thermal, index) => {
    const cluster = new THREE.Group();
    for (let puff = 0; puff < 7; puff++) {
      const mesh = new THREE.Mesh(cloudGeo, cloudMaterial);
      const angle = puff / 7 * Math.PI * 2;
      mesh.position.set(Math.cos(angle) * (10 + puff * 1.2), Math.sin(puff * 2.3) * 3.2, Math.sin(angle) * (7 + puff));
      mesh.scale.set(12 + puff * 1.5, 5 + (puff % 3), 8 + (puff % 2) * 3);
      cluster.add(mesh);
    }
    cluster.position.set(thermal.x, 520 + index * 23, thermal.z);
    cluster.userData.baseX = thermal.x;
    cluster.userData.baseZ = thermal.z;
    cloudGroup.add(cluster);
  });
  group.add(cloudGroup);

  let trees = null;
  const treeTrunkGeometry = new THREE.CylinderGeometry(0.32, 0.48, 4.5, 7);
  const treeCrownGeometry = new THREE.ConeGeometry(2.4, 6.5, 9);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x54371f, roughness: 1 });
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x1e532e, roughness: 0.98 });

  const createChunkMesh = chunk => {
    const resolution = 12;
    const geometry = new THREE.PlaneGeometry(CHUNK_SIZE_M, CHUNK_SIZE_M, resolution, resolution);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    const colors = [];
    for (let i = 0; i < positions.count; i++) {
      const worldX = chunk.centerX + positions.getX(i);
      const worldZ = chunk.centerZ + positions.getZ(i);
      const terrain = world.terrainAt(worldX, worldZ);
      positions.setY(i, terrain.height);
      const color = SURFACE_COLORS[terrain.surface].clone();
      color.offsetHSL(0, 0, (terrain.height % 2) * 0.018);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, terrainMaterial);
    mesh.name = `FLY-chunk-${chunk.key}`;
    mesh.position.set(chunk.centerX - world.origin.x, -world.origin.y, chunk.centerZ - world.origin.z);
    group.add(mesh);
    chunkMeshes.set(chunk.key, mesh);
  };

  const rebuildTrees = () => {
    if (trees) {
      group.remove(trees.group);
      trees = null;
    }
    const placements = [];
    for (const chunk of world.chunks.values()) {
      for (let i = 0; i < 8; i++) {
        const fx = ((i * 0.618033 + chunk.generation) % 1 - 0.5) * CHUNK_SIZE_M;
        const fz = ((i * 0.381966 + chunk.generation * 1.7) % 1 - 0.5) * CHUNK_SIZE_M;
        const x = chunk.centerX + fx, z = chunk.centerZ + fz;
        const terrain = world.terrainAt(x, z);
        if (terrain.surface === "FOREST") placements.push({ x, y: terrain.height, z, scale: 0.75 + (i % 4) * 0.12 });
      }
    }
    const trunks = new THREE.InstancedMesh(treeTrunkGeometry, trunkMaterial, placements.length);
    const crowns = new THREE.InstancedMesh(treeCrownGeometry, crownMaterial, placements.length);
    const dummy = new THREE.Object3D();
    placements.forEach((tree, index) => {
      dummy.position.set(tree.x - world.origin.x, tree.y + 2.25, tree.z - world.origin.z);
      dummy.scale.setScalar(tree.scale);
      dummy.updateMatrix(); trunks.setMatrixAt(index, dummy.matrix);
      dummy.position.y = tree.y + 6.3;
      dummy.updateMatrix(); crowns.setMatrixAt(index, dummy.matrix);
    });
    const treeGroup = new THREE.Group(); treeGroup.add(trunks, crowns); group.add(treeGroup);
    trees = { group: treeGroup, count: placements.length };
  };

  const sync = (simTime = 0) => {
    const nextChunkSignature = [...world.chunks.keys()].sort().join("|");
    const nextOriginSignature = `${world.origin.x},${world.origin.y},${world.origin.z}`;
    if (nextChunkSignature !== chunkSignature) {
      for (const [key, mesh] of chunkMeshes) {
        if (!world.chunks.has(key)) { group.remove(mesh); mesh.geometry.dispose(); chunkMeshes.delete(key); }
      }
      for (const chunk of world.chunks.values()) if (!chunkMeshes.has(chunk.key)) createChunkMesh(chunk);
      chunkSignature = nextChunkSignature;
      rebuildTrees();
    }
    if (nextOriginSignature !== originSignature) {
      for (const chunk of world.chunks.values()) {
        const mesh = chunkMeshes.get(chunk.key);
        if (mesh) mesh.position.set(chunk.centerX - world.origin.x, -world.origin.y, chunk.centerZ - world.origin.z);
      }
      rebuildTrees();
      originSignature = nextOriginSignature;
    }
    cloudGroup.position.set(-world.origin.x, -world.origin.y, -world.origin.z);
    cloudGroup.children.forEach((cloud, index) => {
      cloud.position.x = cloud.userData.baseX + Math.sin(simTime * 0.035 + index) * 5;
      cloud.position.z = cloud.userData.baseZ + Math.cos(simTime * 0.027 + index * 0.7) * 3;
    });
    const cloudProbe = cloudGroup.children[0];
    if (cloudProbe) {
      const cloudAir = atmosphere.sample({
        x: cloudProbe.userData.baseX,
        y: cloudProbe.position.y,
        z: cloudProbe.userData.baseZ
      }, simTime);
      cloudMaterial.opacity = THREE.MathUtils.clamp((cloudAir.humidity01 - 0.12) * 0.92, 0.16, 0.44);
    }
  };

  sync();
  return {
    group,
    sync,
    snapshot() { return { chunks: chunkMeshes.size, trees: trees?.count || 0, clouds: cloudGroup.children.length, drawMeshes: chunkMeshes.size + 4 }; },
    dispose() {
      for (const mesh of chunkMeshes.values()) mesh.geometry.dispose();
      chunkMeshes.clear();
      terrainMaterial.dispose();
      treeTrunkGeometry.dispose(); treeCrownGeometry.dispose();
      trunkMaterial.dispose(); crownMaterial.dispose();
      cloudGeo.dispose(); cloudMaterial.dispose();
      sky.geometry.dispose(); sky.material.dispose();
      scene.remove(group, sky, sun);
    }
  };
}
