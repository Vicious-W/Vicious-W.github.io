// 玻璃耐久、裂纹与破碎几何。
// 输入/输出契约见 docs/engineering/SOURCE_SCENE.md §7。
//
// 本模块不接触 three.js 场景图或 cannon-es 世界对象（碎片的 Mesh/Body 由
// physicalScene.js 创建），只负责：
//   1. 从接触数据推导耐久变化与损伤阶段（INTACT → MICRO_DAMAGED → CRACKED → FRACTURED）；
//   2. 生成裂纹贴图（仅表达表面细节）；
//   3. 生成破碎时的独立碎片几何（真实三维形状，非贴图）。

import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";

export const STAGES = ["INTACT", "MICRO_DAMAGED", "CRACKED", "FRACTURED"];

const E_THRESHOLD = 0.85;      // 最低损伤冲击能量代理（低于此不损伤）
const DAMAGE_K = 0.15;         // 调低后中等冲击需要多次累积才会跨阶段，见 .agent/artifacts/node-check.mjs
const FRACTURE_INSTANT = 6.2;  // 单次超强冲击可直接破碎
const MAX_CRACKS = 7;

// impactEnergy = 0.5 * effectiveMass * normalRelativeSpeed^2（SOURCE_SCENE.md §7.2 的最低代理）
export function impactEnergy(effectiveMass, normalRelativeSpeed) {
  return 0.5 * effectiveMass * normalRelativeSpeed * normalRelativeSpeed;
}

export function createDamageState() {
  return {
    durability: 1.0,
    stage: "INTACT",
    cracks: [] // { u, v, mag } 裂纹起点（立方体展开 UV 近似坐标）
  };
}

function stageFromDurability(d) {
  if (d <= 0.05) return "FRACTURED";
  if (d <= 0.35) return "CRACKED";
  if (d <= 0.7) return "MICRO_DAMAGED";
  return "INTACT";
}

// contact: { normalRelativeSpeed, effectiveMass, localPoint:{x,y,z}, cube }
export function registerImpact(damage, contact) {
  const e = impactEnergy(contact.effectiveMass, contact.normalRelativeSpeed);
  const weaken = 1 - 0.35 * (1 - damage.durability); // 既有裂纹降低后续阈值
  const effectiveThreshold = E_THRESHOLD * weaken;

  if (e > FRACTURE_INSTANT) {
    damage.durability = 0;
  } else if (e > effectiveThreshold) {
    damage.durability = Math.max(0, damage.durability - DAMAGE_K * (e - effectiveThreshold));
  } else {
    return { changed: false, stage: damage.stage, cracked: false };
  }

  const prevStage = damage.stage;
  damage.stage = stageFromDurability(damage.durability);

  let cracked = false;
  if (damage.stage === "CRACKED" || damage.stage === "MICRO_DAMAGED") {
    const u = 0.5 + contact.localPoint.x + contact.localPoint.z * 0.3;
    const v = 0.5 + contact.localPoint.y + contact.localPoint.z * 0.3;
    damage.cracks.push({ u, v, mag: Math.min(1, e / 3) });
    if (damage.cracks.length > MAX_CRACKS) damage.cracks.shift();
    cracked = true;
  }

  return { changed: damage.stage !== prevStage, stage: damage.stage, cracked };
}

// —— 裂纹贴图：只表达表面细节，不代替真实几何 ——
export function buildCrackTexture(cracks, stage) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  if (stage === "INTACT" || !cracks.length) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }
  ctx.strokeStyle = "rgba(235,245,255,0.85)";
  ctx.lineWidth = 1.4;
  cracks.forEach((c, ci) => {
    const cx = THREE.MathUtils.clamp(c.u, 0, 1) * size;
    const cy = THREE.MathUtils.clamp(c.v, 0, 1) * size;
    const branches = 4 + Math.round(c.mag * 5);
    // 确定性伪随机（按裂纹索引播种），保证同一损伤序列产生一致的裂纹外观
    let seed = ci * 7919 + 13;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed % 1000) / 1000;
    };
    for (let b = 0; b < branches; b++) {
      let x = cx, y = cy;
      const angle0 = rand() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segs = 4 + Math.floor(rand() * 4);
      let angle = angle0;
      for (let s = 0; s < segs; s++) {
        angle += (rand() - 0.5) * 1.1;
        const len = (8 + rand() * 22) * (0.5 + c.mag);
        x += Math.cos(angle) * len;
        y += Math.sin(angle) * len;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.beginPath();
    ctx.arc(cx, cy, 2 + c.mag * 2, 0, Math.PI * 2);
    ctx.fill();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// —— 破碎碎片几何：立方体分为 8 个不规则角块，真实三维凸包，不是破碎贴图 ——
function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s % 10000) / 10000;
  };
}

export function buildFragmentGeometries(cube, seed = 1) {
  const rand = seededRand(seed * 97 + 11);
  const half = cube / 2;
  const shards = [];
  for (let ox = -1; ox <= 1; ox += 2) {
    for (let oy = -1; oy <= 1; oy += 2) {
      for (let oz = -1; oz <= 1; oz += 2) {
        const cx = ox * half * 0.5;
        const cy = oy * half * 0.5;
        const cz = oz * half * 0.5;
        const points = [];
        // 角块角点（略微内缩+抖动，制造不规则破碎轮廓）
        for (let i = 0; i < 6; i++) {
          const jitter = () => (rand() - 0.5) * half * 0.22;
          points.push(new THREE.Vector3(
            cx + ox * half * (0.42 + rand() * 0.16) + jitter(),
            cy + oy * half * (0.42 + rand() * 0.16) + jitter(),
            cz + oz * half * (0.42 + rand() * 0.16) + jitter()
          ));
        }
        // 顶点集额外加入中心点保证外壳非退化
        points.push(new THREE.Vector3(cx, cy, cz));
        const geo = new ConvexGeometry(points);
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const size = new THREE.Vector3().subVectors(bb.max, bb.min);
        const center = new THREE.Vector3().addVectors(bb.max, bb.min).multiplyScalar(0.5);
        geo.translate(-center.x, -center.y, -center.z);
        shards.push({
          geometry: geo,
          localCenter: { x: center.x, y: center.y, z: center.z },
          halfExtents: { x: Math.max(size.x / 2, 0.02), y: Math.max(size.y / 2, 0.02), z: Math.max(size.z / 2, 0.02) }
        });
      }
    }
  }
  return shards;
}
