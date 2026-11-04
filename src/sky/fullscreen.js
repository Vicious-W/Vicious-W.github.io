import * as THREE from "three";

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** A full-screen triangle drawn with a raw GLSL 3 shader. */
export function createPass({ vertexShader, fragmentShader, uniforms, defines = {} }) {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false
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
      renderer.render(scene, camera);
    },
    dispose() {
      material.dispose();
    }
  };
}
