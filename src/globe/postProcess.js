import * as Cesium from 'cesium';

// HDR pipeline. Called once from cesiumGlobe init.
//
// The flat white-outlined-decal look is values > 1.0 clipping in an LDR
// pipeline: everything hot saturates straight to white with a hard rim.
// With HDR + filmic tonemapping those values roll off through yellow-white
// instead, and bloom lifts only the genuinely bright spots.
//
// Tonemapping uses Cesium's NATIVE tonemapper (Tonemapper.ACES) rather than
// a custom last PostProcessStage: the native one runs inside the HDR resolve
// AFTER every custom stage — including the per-ignition volumetric fire
// stage added later — so ordering can never break, and there is no risk of
// double-tonemapping. A custom ACES stage is kept only as a fallback for a
// Cesium build without the native property.

const ACES_FALLBACK_SHADER = /* glsl */`
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(colorTexture, v_textureCoordinates).rgb;
  // Narkowicz ACES approximation.
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  out_FragColor = vec4(c, 1.0);
}
`;

export function initPostProcess(viewer) {
  const scene = viewer.scene;
  const stages = scene.postProcessStages;

  // FIRST, per spec: everything below assumes a float target.
  scene.highDynamicRange = true;

  // Subtle bloom: negative brightness raises the threshold so only fire
  // cores and sunlit edges clear it — the frame must not haze over.
  const bloom = stages.bloom;
  bloom.enabled = true;
  bloom.uniforms.glowOnly = false;
  bloom.uniforms.contrast = 128;
  bloom.uniforms.brightness = -0.55;
  bloom.uniforms.delta = 1.0;
  bloom.uniforms.sigma = 2.2;
  bloom.uniforms.stepSize = 1.0;

  let tonemap = 'native-aces';
  if (Cesium.Tonemapper?.ACES !== undefined && 'tonemapper' in stages) {
    stages.tonemapper = Cesium.Tonemapper.ACES;
    if ('exposure' in stages) stages.exposure = 1.0;
  } else {
    tonemap = 'custom-aces-stage';
    stages.add(new Cesium.PostProcessStage({
      name: 'ignis_aces_tonemap',
      fragmentShader: ACES_FALLBACK_SHADER
    }));
  }

  stages.fxaa.enabled = true;

  console.info('[postProcess] HDR on · bloom on · tonemap', tonemap, '· fxaa on');
  return { tonemap };
}
