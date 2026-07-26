// Block-scale (640 m) local scene: ground plane + buildings + roads, with
// fire drawn by replaying the already-solved arrival-time field against a
// scrubbable uTime uniform. No re-solve — see firePropagation.js's
// arrivalTimes (computed once, up front, by the Dijkstra core we don't
// touch); this module only ever reads that array.
//
// Coordinate convention (matches spatialGrid.js and urbanFootprints.js):
//   x = east meters, z = -north meters. Grid row 0 is north (z very
//   negative), row (gridSize-1) is south (z positive); col 0 is west
//   (x very negative), col (gridSize-1) is east (x positive).

import { bufferLineToQuads } from '../lib/urbanFootprints.js';

export const ARRIVAL_SENTINEL_MINUTES = 1e6;
const FRONT_RISE_MINUTES = 60;
const FRONT_FALL_MINUTES = 90;

export function createBlockScene({ THREE, gridSize, cellSizeMeters, fuelCellColors, buildings = [], roads = [] }) {
  const fieldSizeMeters = gridSize * cellSizeMeters;
  const group = new THREE.Group();

  const fuelTexture = new THREE.DataTexture(
    flipRowsToGlTextureOrder(fuelCellColors, gridSize, 4),
    gridSize,
    gridSize,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  fuelTexture.flipY = false;
  fuelTexture.minFilter = THREE.NearestFilter;
  fuelTexture.magFilter = THREE.NearestFilter;
  fuelTexture.needsUpdate = true;

  const arrivalData = new Float32Array(gridSize * gridSize).fill(ARRIVAL_SENTINEL_MINUTES);
  const arrivalTexture = new THREE.DataTexture(
    arrivalData,
    gridSize,
    gridSize,
    THREE.RedFormat,
    THREE.FloatType
  );
  arrivalTexture.flipY = false;
  arrivalTexture.minFilter = THREE.LinearFilter;
  arrivalTexture.magFilter = THREE.LinearFilter;
  arrivalTexture.needsUpdate = true;

  const groundMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uFuelMap: { value: fuelTexture },
      uArrivalMap: { value: arrivalTexture },
      uTime: { value: 0 }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uFuelMap;
      uniform sampler2D uArrivalMap;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec4 fuel = texture2D(uFuelMap, vUv);
        float arrival = texture2D(uArrivalMap, vUv).r;
        float front = smoothstep(arrival - ${FRONT_RISE_MINUTES.toFixed(1)}, arrival, uTime)
          * (1.0 - smoothstep(arrival, arrival + ${FRONT_FALL_MINUTES.toFixed(1)}, uTime));
        float burned = step(arrival, uTime);
        vec3 ashColor = fuel.rgb * 0.22;
        vec3 base = mix(fuel.rgb, ashColor, burned * 0.75);
        vec3 frontColor = vec3(1.0, 0.5, 0.08);
        vec3 color = mix(base, frontColor, front * 0.85);
        // Push the flame front well past 1.0 so tone mapping + bloom pick
        // it up as an ember, same threshold bloomPass already uses for the
        // globe overlay — this is what "drives" bloom, no separate wiring.
        color += front * vec3(2.4, 0.9, 0.1);
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });

  const groundGeometry = new THREE.PlaneGeometry(fieldSizeMeters, fieldSizeMeters, 1, 1);
  groundGeometry.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.renderOrder = 0;
  group.add(ground);

  const buildingMesh = buildBuildingsMesh(THREE, buildings);
  if (buildingMesh) group.add(buildingMesh);

  const roadMesh = buildRoadsMesh(THREE, roads);
  if (roadMesh) group.add(roadMesh);

  function setArrivalField(arrivalMinutesByCell) {
    for (let i = 0; i < arrivalData.length; i += 1) {
      const value = arrivalMinutesByCell?.[i];
      arrivalData[i] = Number.isFinite(value) ? value : ARRIVAL_SENTINEL_MINUTES;
    }
    arrivalTexture.image.data = flipRowsToGlTextureOrder(arrivalData, gridSize, 1);
    arrivalTexture.needsUpdate = true;
  }

  function setTime(modelMinutes) {
    groundMaterial.uniforms.uTime.value = modelMinutes;
  }

  function dispose() {
    groundGeometry.dispose();
    groundMaterial.dispose();
    fuelTexture.dispose();
    arrivalTexture.dispose();
    buildingMesh?.geometry.dispose();
    buildingMesh?.material.dispose();
    roadMesh?.geometry.dispose();
    roadMesh?.material.dispose();
  }

  return { group, groundMaterial, setArrivalField, setTime, dispose };
}

// DataTexture with flipY=false uploads buffer row 0 at v=0 (texture
// "bottom"). Our ground plane's v=1 edge is the north edge (see the
// rotateX(-PI/2) derivation in this file's header comment), so grid row 0
// (north, per spatialGrid.js) must land at buffer row (gridSize-1), i.e.
// rows are stored south-to-north.
function flipRowsToGlTextureOrder(sourceRowMajorNorthFirst, gridSize, channels) {
  const out = sourceRowMajorNorthFirst instanceof Float32Array
    ? new Float32Array(sourceRowMajorNorthFirst.length)
    : new Uint8Array(sourceRowMajorNorthFirst.length);
  const rowLength = gridSize * channels;
  for (let row = 0; row < gridSize; row += 1) {
    const srcStart = row * rowLength;
    const dstStart = (gridSize - 1 - row) * rowLength;
    out.set(sourceRowMajorNorthFirst.subarray(srcStart, srcStart + rowLength), dstStart);
  }
  return out;
}

function buildBuildingsMesh(THREE, buildings) {
  const geometries = [];
  for (const building of buildings) {
    for (const ring of building.rings) {
      if (ring.length < 3) continue;
      // Shape's local Y = -world Z so that, after rotateX(-PI/2), the
      // extruded volume lands at the building's true world (x, z).
      const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(1, building.heightMeters),
        bevelEnabled: false
      });
      geometry.rotateX(-Math.PI / 2);
      geometries.push(geometry);
    }
  }
  if (geometries.length === 0) return null;
  const merged = mergeBufferGeometries(THREE, geometries);
  const material = new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.9, metalness: 0.02 });
  const mesh = new THREE.Mesh(merged, material);
  mesh.renderOrder = 5;
  return mesh;
}

function buildRoadsMesh(THREE, roads) {
  const positions = [];
  for (const road of roads) {
    const quads = bufferLineToQuads(road.line, road.widthMeters);
    for (const quad of quads) {
      const [a, b, c, d] = quad;
      positions.push(
        a.x, 0.05, a.z, b.x, 0.05, b.z, c.x, 0.05, c.z,
        a.x, 0.05, a.z, c.x, 0.05, c.z, d.x, 0.05, d.z
      );
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({ color: 0x2b2b2f });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 3;
  return mesh;
}

// three's BufferGeometryUtils.mergeGeometries isn't imported globally in
// this project; do the minimal merge locally rather than pull in the whole
// examples/jsm/utils module for one call.
function mergeBufferGeometries(THREE, geometries) {
  const positions = [];
  const normals = [];
  for (const geometry of geometries) {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
    const positionAttr = nonIndexed.getAttribute('position');
    const normalAttr = nonIndexed.getAttribute('normal');
    for (let i = 0; i < positionAttr.count; i += 1) {
      positions.push(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      normals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
    }
    if (nonIndexed !== geometry) nonIndexed.dispose();
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

// Builds the ground fuel-color raster (RGBA, north-first row-major) from
// fuel model codes + urban footprint cells. Kept here (not urbanFootprints
// or fireFieldInputs) since it's purely a render concern — non-burnable
// buildings/roads/water/etc all read burnable=false from the same fuel
// decision main.js already computed; this only chooses a display color.
export function buildFuelColorField({ gridSize, fuelModelCodes, burnableByCell, urbanCells }) {
  const data = new Uint8Array(gridSize * gridSize * 4);
  for (let i = 0; i < gridSize * gridSize; i += 1) {
    const offset = i * 4;
    const urban = urbanCells?.[i];
    let color;
    if (urban?.kind === 'building') color = [0x6b, 0x64, 0x58];
    else if (urban?.kind === 'road') color = [0x33, 0x33, 0x38];
    else if (burnableByCell?.[i] === false) color = [0x3a, 0x3a, 0x40];
    else color = [0x3f, 0x5c, 0x2c];
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return data;
}
