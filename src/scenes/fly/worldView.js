import * as THREE from "three";
import { CHUNK_SIZE_M } from "./world/proceduralWorld.js";

const SURFACE_COLORS = {
  FIELD: new THREE.Color(0x5f8b38),
  FOREST: new THREE.Color(0x1d4929),
  ROAD: new THREE.Color(0x77756a),
  WATER: new THREE.Color(0x176f9e)
};

export const FAR_TERRAIN_CONFIG = Object.freeze({
  halfExtentM: 6144,
  segments: 96,
  recenterM: 512,
  verifiedAltitudeM: 500,
  waterLiftM: 0.28
});

export const CLOUD_DENSITY_PROXY = Object.freeze({
  representation: "THREE_DIMENSIONAL_PARTICLE_DENSITY_OPTICAL_PROXY",
  clusters: 10,
  particlesPerCluster: 240,
  advectionScale: 0.58
});

const CLOUD_FIELD_SPAN_M = 3600;
const clamp = THREE.MathUtils.clamp;
const fract = value => value - Math.floor(value);
const seeded = (index, salt) => fract(Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123);
const wrapSigned = (value, span) => ((value + span * 0.5) % span + span) % span - span * 0.5;

function quantizedCenter(position, spacing) {
  return {
    x: Math.round((position?.x || 0) / spacing) * spacing,
    z: Math.round((position?.z || 0) / spacing) * spacing
  };
}

export function deriveCloudVisualState(atmosphere, samplePosition, simTime = 0) {
  const air = atmosphere.sample(samplePosition, simTime);
  const wind = air.windVelocityMps;
  const horizontalSpeedMps = Math.hypot(wind.x, wind.z);
  const density01 = clamp(
    0.18 + (air.humidity01 - 0.18) * 1.5 + Math.max(0, wind.y) * 0.045,
    0.18,
    0.92
  );
  return {
    samplePosition: { ...samplePosition },
    windVelocityMps: { ...wind },
    horizontalSpeedMps,
    headingRad: Math.atan2(wind.x, wind.z),
    density01,
    verticalScale: clamp(0.72 + air.humidity01 * 0.65 + Math.max(0, wind.y) * 0.08, 0.78, 1.35),
    horizontalScale: 1 + horizontalSpeedMps * 0.027,
    advectionM: {
      x: wind.x * simTime * CLOUD_DENSITY_PROXY.advectionScale,
      y: wind.y * simTime * CLOUD_DENSITY_PROXY.advectionScale,
      z: wind.z * simTime * CLOUD_DENSITY_PROXY.advectionScale
    }
  };
}

export function sampleFarTerrainCoverage(world, anchor = { x: 0, z: 0 }, config = FAR_TERRAIN_CONFIG) {
  const center = quantizedCenter(anchor, config.recenterM);
  const cellSizeM = config.halfExtentM * 2 / config.segments;
  const surfaceCounts = { FIELD: 0, FOREST: 0, ROAD: 0, WATER: 0 };
  const cells = [];
  for (let iz = 0; iz < config.segments; iz++) {
    for (let ix = 0; ix < config.segments; ix++) {
      const x = center.x - config.halfExtentM + (ix + 0.5) * cellSizeM;
      const z = center.z - config.halfExtentM + (iz + 0.5) * cellSizeM;
      const terrain = world.surfaceAt(x, z);
      surfaceCounts[terrain.surface]++;
      cells.push({ ix, iz, x, z, height: terrain.height, surface: terrain.surface });
    }
  }
  return {
    center,
    halfExtentM: config.halfExtentM,
    diameterM: config.halfExtentM * 2,
    segments: config.segments,
    cellSizeM,
    verifiedAltitudeM: config.verifiedAltitudeM,
    surfaceCounts,
    cells
  };
}

function makeSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x0b70c4) },
      horizonColor: { value: new THREE.Color(0xc3e5f0) },
      groundColor: { value: new THREE.Color(0x7e956c) },
      sunDirection: { value: new THREE.Vector3(-0.35, 0.72, -0.42).normalize() }
    },
    vertexShader: "varying vec3 vDir; void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
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
  const sky = new THREE.Mesh(new THREE.SphereGeometry(11000, 32, 18), material);
  sky.frustumCulled = false;
  sky.renderOrder = -100;
  return sky;
}

function makeCloudGeometry(clusterIndex) {
  const positions = [];
  const densities = [];
  for (let index = 0; index < CLOUD_DENSITY_PROXY.particlesPerCluster; index++) {
    const radius = Math.cbrt(seeded(index + clusterIndex * 271, 11));
    const azimuth = seeded(index + clusterIndex * 313, 23) * Math.PI * 2;
    const elevation = Math.acos(seeded(index + clusterIndex * 347, 37) * 2 - 1);
    const billow = index % 4;
    const cx = (billow - 1.5) * 12;
    const x = cx + Math.sin(elevation) * Math.cos(azimuth) * radius * (34 + billow * 4);
    const y = Math.cos(elevation) * radius * (12 + (billow % 2) * 3);
    const z = Math.sin(elevation) * Math.sin(azimuth) * radius * (22 + (billow % 3) * 3);
    positions.push(x, y, z);
    densities.push(clamp(1.08 - radius * 0.72 + seeded(index, clusterIndex + 61) * 0.18, 0.22, 1));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("cloudDensity", new THREE.Float32BufferAttribute(densities, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function makeCloudMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      density01: { value: 0.45 },
      pointScale: { value: 650 }
    },
    vertexShader: `
      attribute float cloudDensity;
      varying float vDensity;
      uniform float density01;
      uniform float pointScale;
      void main(){
        vDensity=cloudDensity*density01;
        vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=clamp((0.5+cloudDensity)*pointScale/max(50.0,-mvPosition.z),2.5,28.0);
        gl_Position=projectionMatrix*mvPosition;
      }`,
    fragmentShader: `
      varying float vDensity;
      void main(){
        vec2 p=gl_PointCoord-vec2(0.5);
        float optical=smoothstep(0.25,0.015,dot(p,p));
        float alpha=optical*(0.07+vDensity*0.48);
        if(alpha<0.012) discard;
        vec3 shade=mix(vec3(0.72,0.82,0.88),vec3(1.0),optical*0.75);
        gl_FragColor=vec4(shade,alpha);
      }`
  });
}

function makeSurfaceOverlayGeometry(cells, surface, cellSizeM, liftM) {
  const positions = [];
  const half = cellSizeM * 0.48;
  for (const cell of cells) {
    if (cell.surface !== surface) continue;
    const y = cell.height + liftM;
    positions.push(
      cell.x - half, y, cell.z - half, cell.x + half, y, cell.z - half, cell.x + half, y, cell.z + half,
      cell.x - half, y, cell.z - half, cell.x + half, y, cell.z + half, cell.x - half, y, cell.z + half
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createWorldView({ scene, world, atmosphere }) {
  const group = new THREE.Group();
  group.name = "FLY-procedural-world";
  scene.add(group);

  const nearTerrainMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const farTerrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x168fc0,
    transparent: true,
    opacity: 0.78,
    roughness: 0.16,
    metalness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    depthWrite: false
  });
  let waterShader = null;
  waterMaterial.onBeforeCompile = shader => {
    shader.uniforms.simTime = { value: 0 };
    shader.vertexShader = `uniform float simTime;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\ntransformed.y += sin((position.x + position.z) * 0.055 + simTime * 1.15) * 0.07;"
    );
    waterShader = shader;
  };

  const chunkMeshes = new Map();
  let chunkSignature = "";
  let originSignature = "";
  let farTerrain = null;
  let farCenterSignature = "";
  let lastAnchor = { x: 0, y: 0, z: 0 };
  let lastWindFeedback = null;

  const sky = makeSky();
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffefd2, 3.7);
  sun.position.set(-240, 470, -310);
  scene.add(sun);
  const hemisphere = new THREE.HemisphereLight(0xccecff, 0x44502d, 1.65);
  scene.add(hemisphere);
  scene.fog = new THREE.FogExp2(0xb6d3dd, 0.00017);

  const cloudGroup = new THREE.Group();
  cloudGroup.name = "FLY-state-driven-cloud-volume";
  const cloudEntries = atmosphere.thermals.slice(0, CLOUD_DENSITY_PROXY.clusters).map((thermal, index) => {
    const geometry = makeCloudGeometry(index);
    const material = makeCloudMaterial();
    const points = new THREE.Points(geometry, material);
    points.name = `FLY-cloud-density-${index + 1}`;
    points.userData.baseOffset = { x: thermal.x, z: thermal.z };
    points.userData.baseY = 470 + index * 31;
    cloudGroup.add(points);
    return { points, geometry, material, state: null };
  });
  group.add(cloudGroup);

  const windCount = 84;
  const windGeometry = new THREE.BufferGeometry();
  windGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(windCount * 3), 3));
  const windMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      color: { value: new THREE.Color(0xd9f5ff) },
      opacity: { value: 0.36 }
    },
    vertexShader: `
      void main(){
        vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=clamp(155.0/max(28.0,-mvPosition.z),1.4,5.0);
        gl_Position=projectionMatrix*mvPosition;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float opacity;
      void main(){
        vec2 p=gl_PointCoord-vec2(0.5);
        float optical=smoothstep(0.25,0.035,dot(p,p));
        if(optical<0.02) discard;
        gl_FragColor=vec4(color,optical*opacity);
      }`
  });
  const windTracers = new THREE.Points(windGeometry, windMaterial);
  windTracers.name = "FLY-authoritative-wind-tracers";
  group.add(windTracers);

  const thermalCount = Math.min(12, atmosphere.thermals.length) * 10;
  const thermalGeometry = new THREE.BufferGeometry();
  thermalGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(thermalCount * 3), 3));
  thermalGeometry.setAttribute("thermalColor", new THREE.Float32BufferAttribute(new Float32Array(thermalCount * 3), 3));
  const thermalMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { opacity: { value: 0.24 } },
    vertexShader: `
      attribute vec3 thermalColor;
      varying vec3 vColor;
      void main(){
        vColor=thermalColor;
        vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=clamp(190.0/max(34.0,-mvPosition.z),1.3,5.2);
        gl_Position=projectionMatrix*mvPosition;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      uniform float opacity;
      void main(){
        vec2 p=gl_PointCoord-vec2(0.5);
        float optical=smoothstep(0.25,0.04,dot(p,p));
        if(optical<0.02) discard;
        gl_FragColor=vec4(vColor,optical*opacity);
      }`
  });
  const thermalMotes = new THREE.Points(thermalGeometry, thermalMaterial);
  thermalMotes.name = "FLY-authoritative-thermal-motes";
  group.add(thermalMotes);

  let obstacleVisuals = null;
  const treeTrunkGeometry = new THREE.CylinderGeometry(0.32, 0.48, 4.5, 7);
  const treeCrownGeometry = new THREE.ConeGeometry(2.4, 6.5, 9);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x54371f, roughness: 1 });
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0x1e532e, roughness: 0.98 });
  const farForestGeometry = new THREE.ConeGeometry(7.5, 20, 5);
  const farForestMaterial = new THREE.MeshStandardMaterial({ color: 0x173c24, roughness: 1 });
  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildingMaterial = new THREE.MeshStandardMaterial({ color: 0xb7aa91, roughness: 0.88 });
  const poleGeometry = new THREE.CylinderGeometry(0.18, 0.25, 1, 8);
  const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x4b3828, roughness: 0.92 });
  const wireMaterial = new THREE.LineBasicMaterial({ color: 0x262d32 });

  const createChunkMesh = chunk => {
    const resolution = 12;
    const geometry = new THREE.PlaneGeometry(CHUNK_SIZE_M, CHUNK_SIZE_M, resolution, resolution);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    const colors = [];
    for (let i = 0; i < positions.count; i++) {
      const worldX = chunk.centerX + positions.getX(i);
      const worldZ = chunk.centerZ + positions.getZ(i);
      const terrain = world.surfaceAt(worldX, worldZ);
      positions.setY(i, terrain.height);
      const color = SURFACE_COLORS[terrain.surface].clone();
      color.offsetHSL(0, 0, (terrain.height % 2) * 0.018);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, nearTerrainMaterial);
    mesh.name = `FLY-chunk-${chunk.key}`;
    mesh.position.set(chunk.centerX - world.origin.x, -world.origin.y, chunk.centerZ - world.origin.z);
    group.add(mesh);
    chunkMeshes.set(chunk.key, mesh);
  };

  const disposeFarTerrain = () => {
    if (!farTerrain) return;
    group.remove(farTerrain.group);
    farTerrain.ground.geometry.dispose();
    farTerrain.water.geometry.dispose();
    farTerrain.forest.dispose();
    farTerrain = null;
  };

  const rebuildFarTerrain = center => {
    disposeFarTerrain();
    const coverage = sampleFarTerrainCoverage(world, center);
    const size = coverage.halfExtentM * 2;
    const geometry = new THREE.PlaneGeometry(size, size, coverage.segments, coverage.segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    const colors = [];
    for (let index = 0; index < positions.count; index++) {
      const worldX = coverage.center.x + positions.getX(index);
      const worldZ = coverage.center.z + positions.getZ(index);
      const terrain = world.surfaceAt(worldX, worldZ);
      positions.setY(index, terrain.height - 0.1);
      const color = SURFACE_COLORS[terrain.surface].clone();
      color.offsetHSL(0, 0, Math.sin((worldX + worldZ) * 0.012) * 0.018);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const ground = new THREE.Mesh(geometry, farTerrainMaterial);
    ground.name = "FLY-far-terrain-lod";

    const localCells = coverage.cells.map(cell => ({
      ...cell,
      x: cell.x - coverage.center.x,
      z: cell.z - coverage.center.z
    }));
    const waterGeometry = makeSurfaceOverlayGeometry(
      localCells,
      "WATER",
      coverage.cellSizeM,
      FAR_TERRAIN_CONFIG.waterLiftM
    );
    const water = new THREE.Mesh(waterGeometry, waterMaterial);
    water.name = "FLY-water-surface-cells";
    water.renderOrder = 2;

    const forestCells = localCells.filter(cell => cell.surface === "FOREST"
      && cell.ix % 2 === 0 && cell.iz % 2 === 0
      && Math.hypot(cell.x, cell.z) > 430);
    const forest = new THREE.InstancedMesh(farForestGeometry, farForestMaterial, forestCells.length);
    forest.name = "FLY-far-forest-scale-markers";
    const dummy = new THREE.Object3D();
    forestCells.forEach((cell, index) => {
      const scale = 0.75 + seeded(cell.ix + cell.iz * coverage.segments, 83) * 0.55;
      dummy.position.set(cell.x, cell.height + 10 * scale, cell.z);
      dummy.scale.setScalar(scale);
      dummy.rotation.y = seeded(cell.iz + cell.ix * 7, 97) * Math.PI;
      dummy.updateMatrix();
      forest.setMatrixAt(index, dummy.matrix);
    });
    forest.instanceMatrix.needsUpdate = true;

    const farGroup = new THREE.Group();
    farGroup.name = "FLY-far-render-domain";
    farGroup.add(ground, water, forest);
    farGroup.position.set(
      coverage.center.x - world.origin.x,
      -world.origin.y,
      coverage.center.z - world.origin.z
    );
    group.add(farGroup);
    farTerrain = {
      group: farGroup,
      ground,
      water,
      forest,
      coverage,
      forestMarkers: forestCells.length,
      waterCells: coverage.surfaceCounts.WATER
    };
  };

  const disposeObstacleVisuals = () => {
    if (obstacleVisuals) {
      group.remove(obstacleVisuals.group);
      obstacleVisuals.wireGeometry?.dispose();
      obstacleVisuals.instances.forEach(instance => instance.dispose());
      obstacleVisuals = null;
    }
  };

  const rebuildObstacles = () => {
    disposeObstacleVisuals();
    const treePlacements = [], poles = [], buildings = [], lines = [];
    for (const chunk of world.chunks.values()) {
      for (const obstacle of chunk.obstacles) {
        if (obstacle.type === "TREE") treePlacements.push(obstacle);
        else if (obstacle.type === "POWER_POLE") poles.push(obstacle);
        else if (obstacle.type === "BUILDING") buildings.push(obstacle);
        else if (obstacle.type === "POWER_LINE") lines.push(obstacle);
      }
    }
    const trunks = new THREE.InstancedMesh(treeTrunkGeometry, trunkMaterial, treePlacements.length);
    const crowns = new THREE.InstancedMesh(treeCrownGeometry, crownMaterial, treePlacements.length);
    const dummy = new THREE.Object3D();
    treePlacements.forEach((tree, index) => {
      dummy.position.set(tree.x - world.origin.x, tree.baseY + 2.25 - world.origin.y, tree.z - world.origin.z);
      dummy.scale.setScalar(tree.scale);
      dummy.updateMatrix(); trunks.setMatrixAt(index, dummy.matrix);
      dummy.position.y = tree.baseY + 6.3 - world.origin.y;
      dummy.updateMatrix(); crowns.setMatrixAt(index, dummy.matrix);
    });
    const poleInstances = new THREE.InstancedMesh(poleGeometry, poleMaterial, poles.length);
    poles.forEach((pole, index) => {
      dummy.position.set(pole.x - world.origin.x, pole.baseY + pole.height * 0.5 - world.origin.y, pole.z - world.origin.z);
      dummy.scale.set(1, pole.height, 1);
      dummy.updateMatrix(); poleInstances.setMatrixAt(index, dummy.matrix);
    });
    const visualGroup = new THREE.Group();
    visualGroup.add(trunks, crowns, poleInstances);
    for (const building of buildings) {
      const mesh = new THREE.Mesh(buildingGeometry, buildingMaterial);
      mesh.position.set(building.x - world.origin.x, building.baseY + building.height * 0.5 - world.origin.y, building.z - world.origin.z);
      mesh.scale.set(building.halfX * 2, building.height, building.halfZ * 2);
      visualGroup.add(mesh);
    }
    let wireGeometry = null;
    if (lines.length) {
      const points = [];
      for (const line of lines) points.push(
        line.ax - world.origin.x, line.ay - world.origin.y, line.az - world.origin.z,
        line.bx - world.origin.x, line.by - world.origin.y, line.bz - world.origin.z
      );
      wireGeometry = new THREE.BufferGeometry();
      wireGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      visualGroup.add(new THREE.LineSegments(wireGeometry, wireMaterial));
    }
    group.add(visualGroup);
    obstacleVisuals = {
      group: visualGroup,
      wireGeometry,
      trees: treePlacements.length,
      buildings: buildings.length,
      poles: poles.length,
      lines: lines.length,
      instances: [trunks, crowns, poleInstances]
    };
  };

  const syncClouds = simTime => {
    const fieldCenter = quantizedCenter(lastAnchor, CLOUD_FIELD_SPAN_M);
    cloudEntries.forEach((entry, index) => {
      const baseOffset = entry.points.userData.baseOffset;
      const samplePosition = {
        x: fieldCenter.x + baseOffset.x,
        y: entry.points.userData.baseY,
        z: fieldCenter.z + baseOffset.z
      };
      const state = deriveCloudVisualState(atmosphere, samplePosition, simTime);
      const logicalX = fieldCenter.x + wrapSigned(baseOffset.x + state.advectionM.x, CLOUD_FIELD_SPAN_M);
      const logicalZ = fieldCenter.z + wrapSigned(baseOffset.z + state.advectionM.z, CLOUD_FIELD_SPAN_M);
      entry.points.position.set(
        logicalX - world.origin.x,
        samplePosition.y + Math.sin(index * 1.7 + simTime * 0.025) * 3 - world.origin.y,
        logicalZ - world.origin.z
      );
      entry.points.rotation.y = state.headingRad;
      entry.points.scale.set(state.horizontalScale, state.verticalScale, 1);
      entry.material.uniforms.density01.value = state.density01;
      entry.state = {
        ...state,
        logicalPosition: { x: logicalX, y: samplePosition.y, z: logicalZ },
        particleCount: CLOUD_DENSITY_PROXY.particlesPerCluster
      };
    });
  };

  const syncWindAndThermals = simTime => {
    const samplePosition = { x: lastAnchor.x, y: lastAnchor.y + 8, z: lastAnchor.z };
    const air = atmosphere.sample(samplePosition, simTime);
    const wind = air.windVelocityMps;
    const horizontalSpeedMps = Math.max(0.01, Math.hypot(wind.x, wind.z));
    const direction = { x: wind.x / horizontalSpeedMps, z: wind.z / horizontalSpeedMps };
    const perpendicular = { x: -direction.z, z: direction.x };
    const positions = windGeometry.attributes.position;
    for (let index = 0; index < windCount; index++) {
      const lane = index % 7;
      const phase = (Math.floor(index / 7) / 12 + simTime * horizontalSpeedMps / 92 + seeded(index, 109)) % 1;
      const along = (phase - 0.5) * 96;
      const across = (lane - 3) * 3.2;
      positions.setXYZ(
        index,
        lastAnchor.x - world.origin.x + direction.x * along + perpendicular.x * across,
        lastAnchor.y - world.origin.y + 7 + (index % 4) * 2.2 + Math.sin(index * 2.1 + simTime) * 0.45,
        lastAnchor.z - world.origin.z + direction.z * along + perpendicular.z * across
      );
    }
    positions.needsUpdate = true;
    windMaterial.uniforms.opacity.value = clamp(0.16 + horizontalSpeedMps * 0.035, 0.18, 0.58);
    lastWindFeedback = {
      samplePosition,
      windVelocityMps: { ...wind },
      horizontalSpeedMps,
      tracerDirection: { ...direction },
      thermalVerticalMps: wind.y
    };

    const thermalPositions = thermalGeometry.attributes.position;
    const thermalColors = thermalGeometry.attributes.thermalColor;
    atmosphere.thermals.slice(0, 12).forEach((thermal, thermalIndex) => {
      const thermalAir = atmosphere.sample({ x: thermal.x, y: 80, z: thermal.z }, simTime);
      const riseMps = Math.max(0.12, thermalAir.windVelocityMps.y);
      for (let mote = 0; mote < 10; mote++) {
        const index = thermalIndex * 10 + mote;
        const phase = (mote / 10 + simTime * riseMps / 420) % 1;
        const angle = mote * 2.4 + simTime * 0.16;
        const radius = thermal.radius * (0.12 + phase * 0.2);
        thermalPositions.setXYZ(
          index,
          thermal.x - world.origin.x + Math.cos(angle) * radius,
          12 + phase * 420 - world.origin.y,
          thermal.z - world.origin.z + Math.sin(angle) * radius
        );
        const strength = clamp(riseMps / 2.4, 0.12, 1);
        thermalColors.setXYZ(index, 0.55 + strength * 0.42, 0.68 + strength * 0.22, 0.42 - strength * 0.18);
      }
    });
    thermalPositions.needsUpdate = true;
    thermalColors.needsUpdate = true;

    scene.fog.density = clamp(0.00011 + air.humidity01 * 0.00013, 0.00013, 0.00022);
    sky.material.uniforms.horizonColor.value.setHSL(0.54, 0.52, clamp(0.77 + air.humidity01 * 0.08, 0.78, 0.84));
  };

  const sync = (simTime = 0, anchorPosition = lastAnchor) => {
    lastAnchor = { x: anchorPosition.x || 0, y: anchorPosition.y || 0, z: anchorPosition.z || 0 };
    const nextChunkSignature = [...world.chunks.keys()].sort().join("|");
    const nextOriginSignature = `${world.origin.x},${world.origin.y},${world.origin.z}`;
    if (nextChunkSignature !== chunkSignature) {
      for (const [key, mesh] of chunkMeshes) {
        if (!world.chunks.has(key)) { group.remove(mesh); mesh.geometry.dispose(); chunkMeshes.delete(key); }
      }
      for (const chunk of world.chunks.values()) if (!chunkMeshes.has(chunk.key)) createChunkMesh(chunk);
      chunkSignature = nextChunkSignature;
      rebuildObstacles();
    }

    const nextFarCenter = quantizedCenter(lastAnchor, FAR_TERRAIN_CONFIG.recenterM);
    const nextFarSignature = `${nextFarCenter.x},${nextFarCenter.z}`;
    if (nextFarSignature !== farCenterSignature) {
      rebuildFarTerrain(nextFarCenter);
      farCenterSignature = nextFarSignature;
    }

    if (nextOriginSignature !== originSignature) {
      for (const chunk of world.chunks.values()) {
        const mesh = chunkMeshes.get(chunk.key);
        if (mesh) mesh.position.set(chunk.centerX - world.origin.x, -world.origin.y, chunk.centerZ - world.origin.z);
      }
      if (farTerrain) farTerrain.group.position.set(
        farTerrain.coverage.center.x - world.origin.x,
        -world.origin.y,
        farTerrain.coverage.center.z - world.origin.z
      );
      rebuildObstacles();
      originSignature = nextOriginSignature;
    }

    sky.position.set(
      lastAnchor.x - world.origin.x,
      lastAnchor.y - world.origin.y,
      lastAnchor.z - world.origin.z
    );
    if (waterShader) waterShader.uniforms.simTime.value = simTime;
    syncClouds(simTime);
    syncWindAndThermals(simTime);
  };

  sync();
  return {
    group,
    sync,
    snapshot() {
      return {
        chunks: chunkMeshes.size,
        trees: obstacleVisuals?.trees || 0,
        buildings: obstacleVisuals?.buildings || 0,
        powerPoles: obstacleVisuals?.poles || 0,
        powerLines: obstacleVisuals?.lines || 0,
        clouds: cloudEntries.length,
        cloudField: {
          representation: CLOUD_DENSITY_PROXY.representation,
          particles: cloudEntries.length * CLOUD_DENSITY_PROXY.particlesPerCluster,
          states: cloudEntries.map(entry => entry.state)
        },
        farTerrain: farTerrain ? {
          center: { ...farTerrain.coverage.center },
          diameterM: farTerrain.coverage.diameterM,
          halfExtentM: farTerrain.coverage.halfExtentM,
          cellSizeM: farTerrain.coverage.cellSizeM,
          verifiedAltitudeM: farTerrain.coverage.verifiedAltitudeM,
          surfaceCounts: { ...farTerrain.coverage.surfaceCounts },
          waterCells: farTerrain.waterCells,
          forestMarkers: farTerrain.forestMarkers,
          surfaceSource: "proceduralWorld.surfaceAt (same surface field returned by terrainAt)"
        } : null,
        weatherFeedback: lastWindFeedback,
        thermalColumns: Math.min(12, atmosphere.thermals.length),
        drawMeshes: chunkMeshes.size + cloudEntries.length + 13
      };
    },
    dispose() {
      for (const mesh of chunkMeshes.values()) mesh.geometry.dispose();
      chunkMeshes.clear();
      disposeFarTerrain();
      nearTerrainMaterial.dispose();
      farTerrainMaterial.dispose();
      waterMaterial.dispose();
      treeTrunkGeometry.dispose(); treeCrownGeometry.dispose();
      trunkMaterial.dispose(); crownMaterial.dispose();
      farForestGeometry.dispose(); farForestMaterial.dispose();
      buildingGeometry.dispose(); buildingMaterial.dispose();
      poleGeometry.dispose(); poleMaterial.dispose();
      wireMaterial.dispose(); obstacleVisuals?.wireGeometry?.dispose();
      obstacleVisuals?.instances.forEach(instance => instance.dispose());
      cloudEntries.forEach(entry => { entry.geometry.dispose(); entry.material.dispose(); });
      windGeometry.dispose(); windMaterial.dispose();
      thermalGeometry.dispose(); thermalMaterial.dispose();
      sky.geometry.dispose(); sky.material.dispose();
      scene.remove(group, sky, sun, hemisphere);
      scene.fog = null;
    }
  };
}
