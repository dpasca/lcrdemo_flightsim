import * as THREE from "three";

const TAU = Math.PI * 2;
export const SEA_LEVEL = -52;
const TERRAIN_SNAP_SIZE = 2400;
export const TERRAIN_LEVELS = [
  { outer: 7200, inner: 0, segments: 62 },
  { outer: 28000, inner: 7200, segments: 48 },
  { outer: 76000, inner: 28000, segments: 40 },
  { outer: 154000, inner: 76000, segments: 30 },
] as const;
export const WORLD_WRAP_RADIUS = 178000;
export const WORLD_WRAP_SIZE = WORLD_WRAP_RADIUS * 2;
export const MINIMAP_WORLD_SPAN = TERRAIN_LEVELS[TERRAIN_LEVELS.length - 1].outer;

export function createTerrainSystem() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.02,
    flatShading: true,
  });
  let anchorX = Number.POSITIVE_INFINITY;
  let anchorZ = Number.POSITIVE_INFINITY;
  let activeBands = 0;

  const update = (position: THREE.Vector3) => {
    const nextX = Math.round(position.x / TERRAIN_SNAP_SIZE) * TERRAIN_SNAP_SIZE;
    const nextZ = Math.round(position.z / TERRAIN_SNAP_SIZE) * TERRAIN_SNAP_SIZE;

    if (
      Math.abs(nextX - anchorX) < TERRAIN_SNAP_SIZE &&
      Math.abs(nextZ - anchorZ) < TERRAIN_SNAP_SIZE
    ) {
      return;
    }

    anchorX = nextX;
    anchorZ = nextZ;
    group.position.set(anchorX, 0, anchorZ);

    for (const child of group.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
      }
    }
    group.clear();

    for (const level of TERRAIN_LEVELS) {
      const patch = new THREE.Mesh(
        terrainGeometry(level.outer, level.inner, level.segments, anchorX, anchorZ),
        material,
      );
      patch.receiveShadow = true;
      patch.castShadow = false;
      group.add(patch);
    }

    activeBands = TERRAIN_LEVELS.length;
  };

  return {
    group,
    update,
    get activeBands() {
      return activeBands;
    },
  };
}

function terrainGeometry(
  outerSize: number,
  innerSize: number,
  segments: number,
  offsetX: number,
  offsetZ: number,
) {
  const half = outerSize / 2;
  const innerHalf = innerSize / 2;
  const step = outerSize / segments;
  const positions: number[] = [];
  const colors: number[] = [];

  if (innerSize <= 0) {
    addTerrainRect(positions, colors, -half, half, -half, half, step, offsetX, offsetZ);
  } else {
    addTerrainRect(positions, colors, -half, half, innerHalf, half, step, offsetX, offsetZ);
    addTerrainRect(positions, colors, -half, half, -half, -innerHalf, step, offsetX, offsetZ);
    addTerrainRect(positions, colors, -half, -innerHalf, -innerHalf, innerHalf, step, offsetX, offsetZ);
    addTerrainRect(positions, colors, innerHalf, half, -innerHalf, innerHalf, step, offsetX, offsetZ);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function addTerrainRect(
  positions: number[],
  colors: number[],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  targetStep: number,
  offsetX: number,
  offsetZ: number,
) {
  if (maxX <= minX || maxZ <= minZ) {
    return;
  }

  const xSegments = Math.max(1, Math.ceil((maxX - minX) / targetStep));
  const zSegments = Math.max(1, Math.ceil((maxZ - minZ) / targetStep));

  for (let ix = 0; ix < xSegments; ix += 1) {
    for (let iz = 0; iz < zSegments; iz += 1) {
      const x0 = offsetX + THREE.MathUtils.lerp(minX, maxX, ix / xSegments);
      const z0 = offsetZ + THREE.MathUtils.lerp(minZ, maxZ, iz / zSegments);
      const x1 = offsetX + THREE.MathUtils.lerp(minX, maxX, (ix + 1) / xSegments);
      const z1 = offsetZ + THREE.MathUtils.lerp(minZ, maxZ, (iz + 1) / zSegments);

      addTerrainCell(positions, colors, x0, z0, x1, z1, offsetX, offsetZ);
    }
  }
}

function addTerrainCell(
  positions: number[],
  colors: number[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  offsetX: number,
  offsetZ: number,
) {
  const p0 = terrainPoint(x0, z0);
  const p1 = terrainPoint(x1, z0);
  const p2 = terrainPoint(x1, z1);
  const p3 = terrainPoint(x0, z1);

  if (Math.max(p0.y, p1.y, p2.y, p3.y) < SEA_LEVEL - 6) {
    return;
  }

  addTerrainTriangle(positions, colors, p0, p2, p1, offsetX, offsetZ);
  addTerrainTriangle(positions, colors, p2, p0, p3, offsetX, offsetZ);
}

function addTerrainTriangle(
  positions: number[],
  colors: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  offsetX: number,
  offsetZ: number,
) {
  positions.push(
    a.x - offsetX,
    a.y,
    a.z - offsetZ,
    b.x - offsetX,
    b.y,
    b.z - offsetZ,
    c.x - offsetX,
    c.y,
    c.z - offsetZ,
  );

  const faceColor = terrainColor((a.y + b.y + c.y) / 3, a, b, c);
  for (let i = 0; i < 3; i += 1) {
    colors.push(faceColor.r, faceColor.g, faceColor.b);
  }
}

function terrainPoint(x: number, z: number) {
  return new THREE.Vector3(x, heightAt(x, z), z);
}

export function heightAt(x: number, z: number) {
  const wx = x / WORLD_WRAP_SIZE;
  const wz = z / WORLD_WRAP_SIZE;
  const broad =
    Math.sin(wx * TAU * 18 + 1.7) * 90 +
    Math.cos(wz * TAU * 15 - 0.9) * 78 +
    Math.sin((wx + wz) * TAU * 7) * 105;
  const ridges =
    Math.abs(Math.sin((wx * 38 + wz * 16) * TAU)) * 82 +
    Math.abs(Math.cos((wz * 31 - wx * 6) * TAU)) * 46;
  const plateau = Math.sin((wx * 4 - wz * 5) * TAU) * 180;
  return broad + ridges + plateau - 165;
}

function terrainColor(
  height: number,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
) {
  const color = new THREE.Color();
  const normal = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
  const sunAmount = THREE.MathUtils.clamp(normal.dot(new THREE.Vector3(0.5, 0.72, 0.28)), 0, 1);

  if (height < SEA_LEVEL + 10) {
    color.set(0x255f70);
  } else if (height < 28) {
    color.set(0x4d7352);
  } else if (height < 170) {
    color.set(0x738757);
  } else if (height < 330) {
    color.set(0x8f8469);
  } else {
    color.set(0xd6d0bc);
  }

  color.offsetHSL(0, 0.02, -0.1 + sunAmount * 0.18);
  return color;
}

export function createHorizonMarkers() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffe79d,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });

  for (let i = 0; i < 72; i += 1) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(18, 180, 18), material);
    const angle = (i / 72) * Math.PI * 2;
    const radius = 62000;
    marker.position.set(Math.cos(angle) * radius, 120, Math.sin(angle) * radius);
    marker.rotation.y = -angle;
    group.add(marker);
  }

  return group;
}
