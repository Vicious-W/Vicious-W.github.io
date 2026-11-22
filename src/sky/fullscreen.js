import * as THREE from "three";

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * A full-screen triangle drawn with a raw GLSL 3 shader. over: draw over what is in the target,
 * the shader giving light (rgb) and how much of what is there shows through (a); the target's
 * alpha is kept.
 */
export function createPass({ vertexShader, fragmentShader, uniforms, defines = {}, over = false }) {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    ...(over
      ? {
          transparent: true,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.SrcAlphaFactor,
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.OneFactor
        }
      : {})
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return {
    material,
    uniforms,
    render(renderer, target = null) {
      renderer.setRenderTarget(target);
      // Drawn over the target: it must not be cleared first.
      const autoClear = renderer.autoClear;
      if (over) renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    },
    /** Compiles its shader without holding up the frames (where the browser can), ahead of its first use. */
    compile(renderer) {
      return renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve(renderer.compile(scene, camera));
    },
    dispose() {
      material.dispose();
    }
  };
}
