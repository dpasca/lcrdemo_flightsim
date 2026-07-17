import * as THREE from "three";

export function addQuad(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
) {
  addTriangle(positions, a, b, c);
  addTriangle(positions, c, d, a);
}

export function addPolygon(positions: number[], points: THREE.Vector3[]) {
  for (let i = 1; i < points.length - 1; i += 1) {
    addTriangle(positions, points[0], points[i], points[i + 1]);
  }
}

export function addTriangle(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

export function bufferGeometryFromPositions(positions: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
