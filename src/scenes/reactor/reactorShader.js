// 反应堆重水池的 GLSL，被两处共用：
//   1. reactorScene.js —— 原生 WebGL1 首屏即时渲染 / 兜底
//   2. glassCubes.js  —— Three.js 场景里池底那块平面的材质
// 两边必须是同一份，否则玻璃立方体加载完成时画面会跳一下。
//
// 这里**只有池子本身**。表层玻璃从前是在这个 shader 里用屏幕空间分格"画"出来的，
// 那条路走不通：屏幕上分格永远得不到一个个独立的物体。现在玻璃是 glassCubes.js
// 里真实的三维立方体，各自有体积、有刚体、能被鼠标拖动堆叠。
//
// 写法按 WebGL1 / GLSL ES 1.00 基线（项目教训：WebGL2-only 的写法在
// Windows ANGLE/D3D11 上会静默失败，而无头 SwiftShader 测不出来）。

export const REACTOR_GLSL = `
const float PI = 3.141592653589793;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// 场景坐标：画面中心为原点，短边长度 = 1，y 向上。
vec3 scene(vec2 sp, float t) {
  // 重水轻微扰动：整个池内景物一起微晃
  vec2 w = sp + 0.0022 * vec2(
    sin(sp.y * 9.0 + t * 0.55) + sin(sp.x * 13.0 - t * 0.42),
    sin(sp.x * 8.0 - t * 0.50) + sin(sp.y * 12.0 + t * 0.38));

  vec2 C = vec2(0.0, 0.015);
  vec2 pFl = w - C; // 法兰（浅）
  vec2 pW  = w - C; // 井壁（中）
  vec2 pB  = w - C; // 池底（深）
  float rFl = length(pFl);
  float rW = length(pW);
  float rB = length(pB);

  const float R_OPEN = 0.335;  // 竖井开口半径
  const float R_FLOOR = 0.195; // 池底可见半径（透视收缩）
  const float R_FLGO = 0.475;  // 法兰外缘

  vec3 navy   = vec3(0.006, 0.024, 0.065);
  vec3 deep   = vec3(0.014, 0.075, 0.195);
  vec3 mid    = vec3(0.040, 0.240, 0.580);
  vec3 bright = vec3(0.200, 0.620, 1.000);
  vec3 hot    = vec3(0.780, 0.900, 1.000);

  float aFl = atan(pFl.y, pFl.x);

  // —— 外圈平台：暗蓝金属，只被辉光余晖照亮 ——
  float plat = 0.95 + 0.05 * sin(aFl * 54.0) * sin(rFl * 90.0);
  vec3 col = navy * (0.58 + 0.40 * exp(-rFl * 2.2)) * plat;

  // —— 法兰环 ——
  float flgBand = smoothstep(R_OPEN - 0.004, R_OPEN + 0.006, rFl)
                * (1.0 - smoothstep(R_FLGO - 0.008, R_FLGO + 0.006, rFl));
  float brush = 0.96 + 0.04 * sin(aFl * 72.0);
  vec3 flgCol = mix(deep, mid, 0.75) * brush * (0.55 + 0.90 * exp(-(rFl - R_OPEN) * 6.0));
  float gask = smoothstep(R_OPEN + 0.008, R_OPEN + 0.014, rFl)
             * (1.0 - smoothstep(R_OPEN + 0.020, R_OPEN + 0.028, rFl));
  flgCol = mix(flgCol, vec3(0.06, 0.36, 0.30), gask * 0.22);
  float nBolt = 40.0;
  float ba = (fract(aFl * nBolt / (2.0 * PI) + 0.5) - 0.5) * (2.0 * PI / nBolt);
  float rBoltC = R_OPEN + 0.075;
  vec2 boltRel = vec2(ba * rBoltC, rFl - rBoltC);
  float bd = length(boltRel);
  float bolt = 1.0 - smoothstep(0.010, 0.013, bd);
  float boltRim = smoothstep(0.006, 0.009, bd) * bolt;
  flgCol = mix(flgCol, bright * 0.40, bolt * 0.5);
  flgCol += hot * boltRim * 0.05;
  flgCol = mix(flgCol, deep * 0.8, bolt * (1.0 - smoothstep(0.003, 0.006, abs(boltRel.y))) * 0.7);
  col = mix(col, flgCol, flgBand);

  // —— 竖井井壁：光滑圆柱面，越深越被下方辉光照亮，一侧有柔和镜面弧光 ——
  float opening = 1.0 - smoothstep(R_OPEN - 0.004, R_OPEN + 0.004, rFl);
  float aW = atan(pW.y, pW.x);
  float wallGrad = smoothstep(R_OPEN, R_FLOOR, rW);
  vec3 wallCol = mix(deep * 1.35, mid * 1.30, wallGrad);
  wallCol *= 0.94 + 0.06 * sin(rW * 260.0); // 井壁环向导轨圈
  wallCol += mid * 0.22 * smoothstep(R_OPEN - 0.03, R_OPEN, rW);
  wallCol += bright * 0.14 * pow(max(cos(aW - 2.35), 0.0), 3.0) * (0.4 + 0.6 * wallGrad);
  col = mix(col, wallCol, opening);

  // —— 池底：旋转的方形燃料组件阵，每个组件是一束独立发光棒，而非一块带高光的平板 ——
  float floorMask = (1.0 - smoothstep(R_FLOOR - 0.004, R_FLOOR + 0.004, rB)) * opening;
  vec2 lp = rot(0.42) * pB;
  float L = R_FLOOR * 0.74;
  float sqDist = max(abs(lp.x), abs(lp.y));
  float latMask = 1.0 - smoothstep(L - 0.005, L + 0.005, sqDist);
  vec3 floorBase = deep * (0.85 + 0.45 * exp(-rB * 5.0));

  float cs = 2.0 * L / 8.0;
  vec2 lid = floor(lp / cs);
  vec2 lf = fract(lp / cs) - 0.5;
  float h1 = hash12(lid);
  float h2 = hash12(lid + 19.7);
  float isRod = step(0.90, h1);
  float burnup = 0.5 + 0.5 * h2;

  // 组件内部：3x3 独立棒状燃料元件子网格
  vec2 rp = (lf + 0.5) * 3.0;
  vec2 rid = floor(rp);
  vec2 rf = fract(rp) - 0.5;
  float rh = hash12(lid * 9.0 + rid + 3.1);
  float rodDist = length(rf);
  float rodR = 0.26 + 0.06 * rh;
  float rodMask = 1.0 - smoothstep(rodR - 0.06, rodR + 0.05, rodDist);
  float rodBloom = exp(-rodDist * rodDist * 11.0);

  float gline = smoothstep(0.44, 0.5, max(abs(lf.x), abs(lf.y)));
  vec3 latCol = mix(deep * 1.05, mid * 0.85, burnup);
  latCol = mix(latCol, mix(mid, hot, clamp(burnup * 0.55 + rh * 0.5, 0.0, 1.0)), rodMask);
  latCol += hot * rodBloom * (0.08 + 0.16 * rh) * burnup;
  latCol = mix(latCol, deep * 0.82, gline * 0.75);

  // 控制棒/跟随体格位：十字形导向叶片，比燃料束更暗更冷
  float armX = 1.0 - smoothstep(0.035, 0.11, abs(lf.x));
  float armY = 1.0 - smoothstep(0.035, 0.11, abs(lf.y));
  float blade = clamp(max(armX, armY), 0.0, 1.0);
  vec3 rodCellCol = mix(deep * 0.40, mix(navy * 1.9, mid * 0.5, 0.5), blade);
  latCol = mix(latCol, rodCellCol, isRod);

  latCol *= 0.78 + 0.5 * exp(-sqDist * sqDist / (L * L) * 1.2);
  vec3 floorCol = mix(floorBase, latCol, latMask);
  col = mix(col, floorCol, floorMask);
  col += mid * 0.10 * (1.0 - smoothstep(0.004, 0.012, abs(rB - R_FLOOR))) * opening;

  // —— 切伦科夫辉光：从组件阵向外渗出，贴近棒阵更集中 ——
  float breath = 1.0 + 0.02 * sin(t * 0.35);
  float heat = exp(-max(sqDist - L, 0.0) * 9.0);
  float g2 = exp(-rW * rW * 5.5) * 0.20;
  float g3 = exp(-rFl * rFl * 1.6) * 0.14;
  col += (bright * (g2 + g3) + hot * heat * 0.34 + bright * exp(-rB * 4.0) * 0.18) * breath;

  // —— 切伦科夫闪烁：真实辉光由大量独立粒子事件构成，带快速细碎的闪烁颗粒感 ——
  float scintSeed = hash12(floor(w * 420.0) + floor(t * 16.0) * 7.0);
  float scint = step(0.993, scintSeed);
  col += hot * scint * clamp(heat * 1.3 + g2 * 1.2, 0.0, 1.0) * 0.35;

  // —— 水中光柱：角向噪声，缓慢转动 ——
  float s = sin(aW * 2.0 + t * 0.10) + sin(aW * 4.0 - t * 0.07 + 1.7) + sin(aW * 6.0 + t * 0.05 + 4.1);
  float shaft = pow(max(s, 0.0) / 3.0, 2.5);
  float shaftBand = smoothstep(R_FLOOR * 0.7, R_FLOOR * 1.3, rW)
                  * (1.0 - smoothstep(R_OPEN * 0.9, R_FLGO * 1.35, rW));
  col += bright * shaft * shaftBand * 0.10 * breath;

  // —— 重水中的悬浮微粒：缓慢上漂、闪烁，只在被照亮处可见 ——
  vec2 mp = w * 26.0 + vec2(0.0, -t * 0.22);
  vec2 mCell = floor(mp);
  vec2 mf = fract(mp) - 0.5;
  vec2 mo = hash22(mCell) - 0.5;
  float md = length(mf - mo * 0.8);
  float tw = 0.55 + 0.45 * sin(t * (0.8 + hash12(mCell) * 1.8) + hash12(mCell) * 40.0);
  float mote = (1.0 - smoothstep(0.02, 0.05, md)) * step(0.72, hash12(mCell + 7.3)) * tw;
  col += hot * mote * clamp(heat * 1.2 + g2 * 1.4, 0.0, 1.0) * 0.35;

  return col;
}

// 软拐点压光。玻璃立方体是在**压光之后**的画面上折射的，两边必须用同一条曲线，
// 否则透过玻璃看到的池子和玻璃外的池子会是两种亮度。
vec3 poolColor(vec2 sp, float t) {
  vec3 c = scene(sp, t);
  c = 1.0 - exp(-c * 1.35);
  return pow(c, vec3(0.92));
}
`;
