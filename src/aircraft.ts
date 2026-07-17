import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { addPolygon, addQuad, addTriangle, bufferGeometryFromPositions } from "./geometry";

const TAU = Math.PI * 2;
const F14_FT_TO_UNIT = 0.2;
const F14_DIMENSIONS = {
  // NAVAIR 00-110AF14-1, Standard Aircraft Characteristics, F-14A, April 1977.
  lengthFt: 61.9,
  heightFt: 16,
  maxSpanFt: 64.13,
  sweptSpanFt: 38.2,
  oversweptSpanFt: 33.29,
  unsweptLeadingEdgeDeg: 20,
  sweptLeadingEdgeDeg: 68,
  oversweptLeadingEdgeDeg: 75,
  wingPivotButtlineFt: 96.3 / 12,
  engineDiameterFt: 50.5 / 12,
};
export const F14_WING_SWEEP_DELTA = THREE.MathUtils.degToRad(
  F14_DIMENSIONS.sweptLeadingEdgeDeg - F14_DIMENSIONS.unsweptLeadingEdgeDeg,
);

type F14Materials = ReturnType<typeof createF14Materials>;

export function createF14() {
  const root = new THREE.Group();
  root.name = "Detailed measured F-14A Tomcat";
  root.scale.setScalar(4.5);

  const materials = createF14Materials();
  const noseTipFt = -F14_DIMENSIONS.lengthFt / 2;

  const radome = createLoftedMesh(
    [
      { z: noseTipFt, halfWidth: 0.04, top: 0.02, upper: 0.01, side: 0, lower: -0.02, bottom: -0.04 },
      { z: -29.7, halfWidth: 0.5, top: 0.42, upper: 0.3, side: 0, lower: -0.32, bottom: -0.44 },
      { z: -27.4, halfWidth: 1.12, top: 0.92, upper: 0.64, side: 0.02, lower: -0.58, bottom: -0.76 },
      { z: -24.7, halfWidth: 1.72, top: 1.5, upper: 1.02, side: 0.02, lower: -0.68, bottom: -0.92 },
    ],
    materials.radome,
  );

  const forwardFuselage = createLoftedMesh(
    [
      { z: -24.72, halfWidth: 1.72, top: 1.5, upper: 1.02, side: 0.02, lower: -0.68, bottom: -0.92 },
      { z: -22.0, halfWidth: 2.05, top: 1.96, upper: 1.32, side: 0, lower: -0.76, bottom: -1.02 },
      { z: -18.0, halfWidth: 2.34, top: 2.24, upper: 1.52, side: -0.04, lower: -0.82, bottom: -1.08 },
      { z: -13.0, halfWidth: 2.52, top: 2.2, upper: 1.44, side: -0.08, lower: -0.86, bottom: -1.1 },
      { z: -8.0, halfWidth: 2.64, top: 1.92, upper: 1.18, side: -0.12, lower: -0.82, bottom: -1.02 },
      { z: -2.0, halfWidth: 2.56, top: 1.55, upper: 0.92, side: -0.12, lower: -0.7, bottom: -0.88 },
      { z: 4.8, halfWidth: 2.28, top: 1.25, upper: 0.74, side: -0.08, lower: -0.58, bottom: -0.72 },
    ],
    materials.paint,
  );

  const centerDeck = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: -2.45, z: -8.5 },
        { x: 2.45, z: -8.5 },
        { x: 3.4, z: 2.5 },
        { x: 3.55, z: 17.5 },
        { x: 2.45, z: 28.8 },
        { x: -2.45, z: 28.8 },
        { x: -3.55, z: 17.5 },
        { x: -3.4, z: 2.5 },
      ],
      0.68,
      0,
    ),
    materials.upperPanel,
  );
  centerDeck.position.y = ft(0.38);

  const bellyPlate = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: -2.24, z: -5.8 },
        { x: 2.24, z: -5.8 },
        { x: 2.55, z: 20.5 },
        { x: 1.72, z: 27.5 },
        { x: -1.72, z: 27.5 },
        { x: -2.55, z: 20.5 },
      ],
      0.34,
      0,
    ),
    materials.underside,
  );
  bellyPlate.position.y = ft(-0.82);

  const dorsalSpine = createLoftedMesh(
    [
      { z: -11.4, halfWidth: 1.22, top: 2.04, upper: 1.72, side: 1.34, lower: 1.18, bottom: 1.12 },
      { z: -4.0, halfWidth: 1.46, top: 2.12, upper: 1.8, side: 1.36, lower: 1.14, bottom: 1.06 },
      { z: 6.0, halfWidth: 1.42, top: 2.0, upper: 1.68, side: 1.24, lower: 1.04, bottom: 0.96 },
      { z: 15.5, halfWidth: 1.16, top: 1.74, upper: 1.46, side: 1.08, lower: 0.9, bottom: 0.82 },
      { z: 22.5, halfWidth: 0.62, top: 1.34, upper: 1.14, side: 0.88, lower: 0.78, bottom: 0.72 },
    ],
    materials.paint,
  );

  root.add(radome, forwardFuselage, centerDeck, bellyPlate, dorsalSpine);
  root.add(createCanopy(materials), createNoseDetails(materials));

  const leftWing = createWing(-1, materials);
  const rightWing = createWing(1, materials);
  root.add(leftWing, rightWing);

  root.add(createWingGlove(-1, materials), createWingGlove(1, materials));
  root.add(createShoulderFairing(-1, materials.paint), createShoulderFairing(1, materials.paint));

  root.add(createIntake(-1, materials), createIntake(1, materials));
  const nacelles = [-1, 1].map((side) => {
    const nacelle = createEngineNacelle(side as -1 | 1, materials);
    root.add(nacelle);
    return nacelle;
  });
  root.add(createEngineTunnel(materials.intake), createBeaverTail(materials));

  const leftNozzle = createNozzle(-1, materials);
  const rightNozzle = createNozzle(1, materials);
  root.add(leftNozzle, rightNozzle);

  const afterburnerLeft = createAfterburner(-1, materials);
  const afterburnerRight = createAfterburner(1, materials);
  root.add(afterburnerLeft, afterburnerRight);

  root.add(createVerticalTail(-1, materials), createVerticalTail(1, materials));

  const stabilizerLeft = createStabilizer(-1, materials);
  const stabilizerRight = createStabilizer(1, materials);
  root.add(stabilizerLeft, stabilizerRight);

  root.add(
    createVentralFin(-1, materials.darkPaint),
    createVentralFin(1, materials.darkPaint),
    createBellyOrdnance(materials),
  );

  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = false;
    }
  });

  return {
    root,
    leftWing,
    rightWing,
    leftNozzle,
    rightNozzle,
    afterburnerLeft,
    afterburnerRight,
    stabilizerLeft,
    stabilizerRight,
    nacelles,
  };
}

function createF14Materials() {
  const standard = (parameters: THREE.MeshStandardMaterialParameters) =>
    new THREE.MeshStandardMaterial({
      roughness: 0.66,
      metalness: 0.12,
      side: THREE.DoubleSide,
      ...parameters,
    });

  return {
    paint: standard({ color: 0xb9bebd, roughness: 0.62 }),
    upperPanel: standard({ color: 0xaab1b1, roughness: 0.7 }),
    underside: standard({ color: 0xd9d9cf, roughness: 0.72 }),
    radome: standard({ color: 0x858b89, roughness: 0.82, metalness: 0.06 }),
    darkPaint: standard({ color: 0x353c41, roughness: 0.76, metalness: 0.2 }),
    panelLine: standard({ color: 0x596166, roughness: 0.86, metalness: 0.08 }),
    intake: standard({ color: 0x0b1015, roughness: 0.92, metalness: 0.04 }),
    titanium: standard({ color: 0x666b6d, roughness: 0.48, metalness: 0.72 }),
    nozzleDark: standard({ color: 0x262a2c, roughness: 0.5, metalness: 0.68 }),
    cockpit: standard({ color: 0x11181c, roughness: 0.84, metalness: 0.12 }),
    seat: standard({ color: 0x222c2c, roughness: 0.9, metalness: 0.04 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x234761,
      emissive: 0x06131e,
      emissiveIntensity: 0.32,
      roughness: 0.12,
      metalness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      transparent: true,
      opacity: 0.78,
      depthWrite: true,
      side: THREE.DoubleSide,
    }),
    frame: standard({ color: 0x20292d, roughness: 0.58, metalness: 0.32 }),
    white: standard({ color: 0xe9e7dc, roughness: 0.72, metalness: 0.04 }),
    red: standard({ color: 0x8d2423, roughness: 0.7, metalness: 0.06 }),
    yellow: standard({ color: 0xd7b543, roughness: 0.7, metalness: 0.04 }),
    navRed: standard({
      color: 0xff382b,
      emissive: 0xff1708,
      emissiveIntensity: 2.2,
      roughness: 0.28,
    }),
    navGreen: standard({
      color: 0x30ff84,
      emissive: 0x08ff55,
      emissiveIntensity: 2.2,
      roughness: 0.28,
    }),
    flameOuter: new THREE.MeshBasicMaterial({
      color: 0xff6c1f,
      transparent: true,
      opacity: 0.46,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    flameInner: new THREE.MeshBasicMaterial({
      color: 0xffe9a1,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  };
}

type LoftStation = {
  z: number;
  halfWidth: number;
  top: number;
  upper: number;
  side: number;
  lower: number;
  bottom: number;
};

type PlanformPoint = {
  x: number;
  z: number;
};

type ShoulderRow = {
  z: number;
  innerX: number;
  outerX: number;
  innerY: number;
  outerY: number;
};

type IntakeDuctStation = {
  z: number;
  centerX: number;
  topWidth: number;
  bottomWidth: number;
  top: number;
  bottom: number;
  corner: number;
  skew: number;
};

function ft(value: number) {
  return value * F14_FT_TO_UNIT;
}

function vft(x: number, y: number, z: number) {
  return new THREE.Vector3(ft(x), ft(y), ft(z));
}

function createLoftedMesh(stations: LoftStation[], material: THREE.Material) {
  const sourceGeometry = loftedSectionGeometry(stations);
  sourceGeometry.deleteAttribute("normal");
  const geometry = mergeVertices(sourceGeometry, 0.0001);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

function loftedSectionGeometry(stations: LoftStation[]) {
  const profiles = stations.map(profileFromStation);
  const positions: number[] = [];
  const vertexCount = profiles[0]?.length ?? 0;

  for (let i = 0; i < profiles.length - 1; i += 1) {
    const current = profiles[i];
    const nextProfile = profiles[i + 1];

    for (let j = 0; j < vertexCount; j += 1) {
      const next = (j + 1) % vertexCount;
      addQuad(positions, current[j], current[next], nextProfile[next], nextProfile[j]);
    }
  }

  addPolygon(positions, [...profiles[0]].reverse());
  addPolygon(positions, profiles[profiles.length - 1]);

  return bufferGeometryFromPositions(positions);
}

function profileFromStation(station: LoftStation) {
  const halfWidth = ft(station.halfWidth);
  const z = ft(station.z);

  return [
    new THREE.Vector3(0, ft(station.top), z),
    new THREE.Vector3(halfWidth * 0.58, ft(station.upper), z),
    new THREE.Vector3(halfWidth, ft(station.side), z),
    new THREE.Vector3(halfWidth * 0.62, ft(station.lower), z),
    new THREE.Vector3(0, ft(station.bottom), z),
    new THREE.Vector3(-halfWidth * 0.62, ft(station.lower), z),
    new THREE.Vector3(-halfWidth, ft(station.side), z),
    new THREE.Vector3(-halfWidth * 0.58, ft(station.upper), z),
  ];
}

function createCanopy(materials: F14Materials) {
  const group = new THREE.Group();

  const cockpitBase = createLoftedMesh(
    [
      { z: -24.1, halfWidth: 0.9, top: 1.92, upper: 1.84, side: 1.72, lower: 1.64, bottom: 1.6 },
      { z: -21.0, halfWidth: 1.58, top: 2.42, upper: 2.26, side: 2.06, lower: 1.94, bottom: 1.88 },
      { z: -14.2, halfWidth: 1.66, top: 2.46, upper: 2.28, side: 2.08, lower: 1.96, bottom: 1.9 },
      { z: -11.2, halfWidth: 0.84, top: 2.18, upper: 2.06, side: 1.9, lower: 1.82, bottom: 1.78 },
    ],
    materials.cockpit,
  );

  const glass = createLoftedMesh(
    [
      { z: -23.9, halfWidth: 0.52, top: 2.18, upper: 2.1, side: 1.98, lower: 1.9, bottom: 1.86 },
      { z: -21.5, halfWidth: 1.12, top: 3.7, upper: 3.2, side: 2.48, lower: 2.2, bottom: 2.08 },
      { z: -18.7, halfWidth: 1.42, top: 4.18, upper: 3.56, side: 2.64, lower: 2.3, bottom: 2.16 },
      { z: -15.5, halfWidth: 1.38, top: 4.02, upper: 3.46, side: 2.6, lower: 2.28, bottom: 2.14 },
      { z: -12.5, halfWidth: 0.7, top: 2.68, upper: 2.5, side: 2.2, lower: 2.08, bottom: 2.02 },
    ],
    materials.glass,
  );

  group.add(cockpitBase);
  group.add(createEjectionSeat(-19.5, materials), createEjectionSeat(-15.4, materials));
  group.add(glass);

  const canopyBows = [
    {
      z: -21.5,
      points: [
        [-1.08, 2.43],
        [-0.63, 3.14],
        [0, 3.64],
        [0.63, 3.14],
        [1.08, 2.43],
      ],
    },
    {
      z: -18.7,
      points: [
        [-1.37, 2.58],
        [-0.8, 3.48],
        [0, 4.1],
        [0.8, 3.48],
        [1.37, 2.58],
      ],
    },
    {
      z: -12.7,
      points: [
        [-0.69, 2.17],
        [-0.41, 2.48],
        [0, 2.68],
        [0.41, 2.48],
        [0.69, 2.17],
      ],
    },
  ] as const;

  for (const bow of canopyBows) {
    group.add(
      createTube(
        bow.points.map(([x, y]) => vft(x, y, bow.z)),
        ft(0.035),
        materials.frame,
      ),
    );
  }

  for (const side of [-1, 1]) {
    group.add(
      createTube(
        [
          vft(side * 0.48, 1.96, -23.82),
          vft(side * 1.07, 2.42, -21.5),
          vft(side * 1.37, 2.57, -18.7),
          vft(side * 1.33, 2.53, -15.5),
          vft(side * 0.66, 2.13, -12.5),
        ],
        ft(0.04),
        materials.frame,
      ),
    );
  }

  return group;
}

function createEjectionSeat(zFt: number, materials: F14Materials) {
  const seat = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(ft(0.9), ft(1.45), ft(0.48)), materials.seat);
  back.position.set(0, ft(2.55), ft(zFt));
  back.rotation.x = -0.12;

  const headrest = new THREE.Mesh(
    new THREE.BoxGeometry(ft(0.72), ft(0.5), ft(0.42)),
    materials.darkPaint,
  );
  headrest.position.set(0, ft(3.36), ft(zFt + 0.06));

  const cushion = new THREE.Mesh(
    new THREE.BoxGeometry(ft(0.74), ft(0.2), ft(0.74)),
    materials.seat,
  );
  cushion.position.set(0, ft(1.96), ft(zFt - 0.22));
  seat.add(back, headrest, cushion);
  return seat;
}

function createWing(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  const pivotXFt = F14_DIMENSIONS.wingPivotButtlineFt;
  const movableSpanFt = F14_DIMENSIONS.maxSpanFt / 2 - pivotXFt;
  const sweepOffsetFt =
    Math.tan(THREE.MathUtils.degToRad(F14_DIMENSIONS.unsweptLeadingEdgeDeg)) *
    movableSpanFt;
  const dihedralDeg = -0.7;

  group.position.set(side * ft(pivotXFt), ft(0.24), ft(-4.1));

  const wing = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: 0, z: -1.85 },
        { x: side * movableSpanFt, z: -1.85 + sweepOffsetFt },
        { x: side * (movableSpanFt - 0.58), z: 11.35 },
        { x: side * 4.15, z: 13.7 },
        { x: 0, z: 9.8 },
      ],
      0.44,
      dihedralDeg,
    ),
    materials.paint,
  );
  group.add(wing);

  const leadingEdge = createPlanformOverlay(
    [
      { x: side * 1.15, z: -1.46 },
      { x: side * (movableSpanFt - 0.65), z: -1.35 + sweepOffsetFt },
      { x: side * (movableSpanFt - 1.2), z: -0.35 + sweepOffsetFt },
      { x: side * 2.0, z: -0.72 },
    ],
    dihedralDeg,
    0.24,
    materials.upperPanel,
  );

  const trailingFlap = createPlanformOverlay(
    [
      { x: side * 4.4, z: 12.58 },
      { x: side * (movableSpanFt - 0.8), z: 10.62 },
      { x: side * (movableSpanFt - 1.05), z: 9.72 },
      { x: side * 5.1, z: 11.45 },
    ],
    dihedralDeg,
    0.24,
    materials.underside,
  );

  const spoiler = createPlanformOverlay(
    [
      { x: side * 5.1, z: 5.0 },
      { x: side * 13.5, z: 6.55 },
      { x: side * 13.1, z: 8.18 },
      { x: side * 5.25, z: 7.5 },
    ],
    dihedralDeg,
    0.25,
    materials.upperPanel,
  );
  group.add(leadingEdge, trailingFlap, spoiler);

  const hinge = createTube(
    [vft(side * 4.6, 0, 11.42), vft(side * (movableSpanFt - 1.15), 0, 9.65)],
    ft(0.035),
    materials.panelLine,
  );
  hinge.position.y = ft(
    0.28 + Math.abs((4.6 + movableSpanFt - 1.15) * 0.5) * Math.tan(THREE.MathUtils.degToRad(dihedralDeg)),
  );
  group.add(hinge);

  const pivotCap = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(1.28), ft(1.28), ft(0.13), 24),
    materials.upperPanel,
  );
  pivotCap.position.y = ft(0.34);
  group.add(pivotCap);

  const navLight = new THREE.Mesh(
    new THREE.SphereGeometry(ft(0.16), 10, 6),
    side === -1 ? materials.navRed : materials.navGreen,
  );
  navLight.position.set(
    side * ft(movableSpanFt - 0.3),
    ft(0.22 + movableSpanFt * Math.tan(THREE.MathUtils.degToRad(dihedralDeg))),
    ft(-1.2 + sweepOffsetFt),
  );
  group.add(navLight);

  if (side === -1) {
    const insignia = createNationalInsignia();
    insignia.position.set(side * ft(14.8), ft(0.31 + 14.8 * Math.tan(THREE.MathUtils.degToRad(dihedralDeg))), ft(5.3));
    group.add(insignia);
  }

  return group;
}

function createWingGlove(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  const glove = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: side * 2.42, z: -9.2 },
        { x: side * 4.1, z: -10.25 },
        { x: side * F14_DIMENSIONS.wingPivotButtlineFt, z: -5.95 },
        { x: side * 8.55, z: 8.3 },
        { x: side * 3.2, z: 11.0 },
        { x: side * 2.52, z: 4.6 },
      ],
      0.56,
      -0.35,
    ),
    materials.paint,
  );
  glove.position.y = ft(0.2);
  group.add(glove);

  const walkway = createPlanformOverlay(
    [
      { x: side * 2.72, z: -2.0 },
      { x: side * 5.25, z: -1.1 },
      { x: side * 5.4, z: 6.45 },
      { x: side * 2.9, z: 7.25 },
    ],
    -0.35,
    0.51,
    materials.darkPaint,
  );
  walkway.material = (materials.darkPaint.clone() as THREE.MeshStandardMaterial);
  (walkway.material as THREE.MeshStandardMaterial).color.setHex(0x555d5e);
  group.add(walkway);

  const sweepSeal = createPlanformOverlay(
    [
      { x: side * 6.95, z: -4.6 },
      { x: side * 8.25, z: -5.1 },
      { x: side * 8.45, z: 6.9 },
      { x: side * 7.35, z: 7.25 },
    ],
    -0.35,
    0.52,
    materials.frame,
  );
  group.add(sweepSeal);
  return group;
}

function createShoulderFairing(side: -1 | 1, material: THREE.Material) {
  const mesh = new THREE.Mesh(
    shoulderFairingGeometry(
      side,
      [
        { z: -11.0, innerX: 2.2, outerX: 3.5, innerY: 1.34, outerY: 0.76 },
        { z: -7.0, innerX: 2.48, outerX: 5.7, innerY: 1.3, outerY: 0.58 },
        { z: -1.0, innerX: 2.58, outerX: 7.55, innerY: 1.12, outerY: 0.48 },
        { z: 7.5, innerX: 2.58, outerX: 7.4, innerY: 1.0, outerY: 0.42 },
        { z: 13.8, innerX: 2.42, outerX: 5.4, innerY: 0.88, outerY: 0.48 },
        { z: 18.0, innerX: 2.18, outerX: 3.7, innerY: 0.74, outerY: 0.52 },
      ],
      0.16,
    ),
    material,
  );
  mesh.castShadow = true;
  return mesh;
}

function createIntake(
  side: -1 | 1,
  materials: F14Materials,
) {
  const group = new THREE.Group();
  group.name = side === -1 ? "Left intake" : "Right intake";
  group.position.set(side * ft(5.65), ft(-0.42), ft(-10.3));

  const ductStations: IntakeDuctStation[] = [
    {
      z: -3.6,
      centerX: -side * 0.42,
      topWidth: 3.8,
      bottomWidth: 3.05,
      top: 1.05,
      bottom: -1.25,
      corner: 0.42,
      skew: 1.55,
    },
    {
      z: -2.5,
      centerX: -side * 0.28,
      topWidth: 3.35,
      bottomWidth: 2.95,
      top: 0.98,
      bottom: -1.15,
      corner: 0.38,
      skew: 0.94,
    },
    {
      z: -0.9,
      centerX: -side * 0.14,
      topWidth: 3.22,
      bottomWidth: 2.94,
      top: 0.92,
      bottom: -1,
      corner: 0.34,
      skew: 0.44,
    },
    {
      z: 0.9,
      centerX: -side * 0.05,
      topWidth: 3.28,
      bottomWidth: 3,
      top: 1.02,
      bottom: -0.85,
      corner: 0.3,
      skew: 0.14,
    },
    {
      z: 2.4,
      centerX: 0,
      topWidth: 3.48,
      bottomWidth: 3.02,
      top: 1.15,
      bottom: -0.72,
      corner: 0.27,
      skew: 0,
    },
  ];

  const scoop = new THREE.Mesh(
    intakeDuctGeometry(ductStations, side),
    materials.paint,
  );
  scoop.rotation.z = side * -0.014;
  scoop.castShadow = true;
  group.add(scoop);

  const outerLip = ductStations[0];
  const innerLip: IntakeDuctStation = {
    ...outerLip,
    topWidth: 3.42,
    bottomWidth: 2.72,
    top: 0.78,
    bottom: -0.99,
    corner: 0.28,
  };
  const lip = new THREE.Mesh(
    intakeLipGeometry(outerLip, innerLip, side),
    materials.underside,
  );
  group.add(lip);

  const mouthStation: IntakeDuctStation = {
    ...innerLip,
    z: innerLip.z + 0.16,
  };
  const mouth = new THREE.Mesh(
    intakeSectionGeometry(mouthStation, side),
    materials.intake,
  );
  mouth.castShadow = true;
  group.add(mouth);

  const ramp = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(4.2),
      frontWidth: ft(3.05),
      backWidth: ft(2.72),
      frontHeight: ft(0.1),
      backHeight: ft(0.08),
    }),
    materials.intake,
  );
  ramp.position.set(-side * ft(0.15), ft(0.52), ft(-0.65));
  ramp.rotation.x = -0.075;
  group.add(ramp);

  const warningStripe = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.LineCurve3(
        vft(side * 1.48, 0.52, -2.82),
        vft(side * 1.11, -0.55, -2.82),
      ),
      3,
      ft(0.022),
      5,
      false,
    ),
    materials.red,
  );
  group.add(warningStripe);

  return group;
}

function createEngineNacelle(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  const engineRadiusFt = F14_DIMENSIONS.engineDiameterFt / 2;
  group.position.x = side * ft(5.65);

  const pod = createLoftedMesh(
    [
      { z: -8.0, halfWidth: engineRadiusFt * 1.02, top: 0.92, upper: 0.52, side: -0.28, lower: -1.18, bottom: -1.62 },
      { z: -2.0, halfWidth: engineRadiusFt * 1.08, top: 0.86, upper: 0.44, side: -0.34, lower: -1.25, bottom: -1.7 },
      { z: 8.0, halfWidth: engineRadiusFt * 1.07, top: 0.82, upper: 0.4, side: -0.36, lower: -1.26, bottom: -1.72 },
      { z: 17.0, halfWidth: engineRadiusFt * 1.03, top: 0.78, upper: 0.36, side: -0.38, lower: -1.23, bottom: -1.66 },
      { z: 25.0, halfWidth: engineRadiusFt * 0.97, top: 0.68, upper: 0.28, side: -0.4, lower: -1.14, bottom: -1.5 },
      { z: 29.6, halfWidth: engineRadiusFt * 0.88, top: 0.54, upper: 0.18, side: -0.4, lower: -1.02, bottom: -1.3 },
    ],
    materials.paint,
  );
  group.add(pod);

  const heatShield = createLoftedMesh(
    [
      { z: 16.8, halfWidth: engineRadiusFt * 1.045, top: 0.8, upper: 0.38, side: -0.39, lower: -1.24, bottom: -1.67 },
      { z: 24.8, halfWidth: engineRadiusFt * 0.985, top: 0.7, upper: 0.3, side: -0.41, lower: -1.15, bottom: -1.51 },
      { z: 29.62, halfWidth: engineRadiusFt * 0.89, top: 0.55, upper: 0.19, side: -0.41, lower: -1.03, bottom: -1.31 },
    ],
    materials.titanium,
  );
  group.add(heatShield);

  const panelBand = new THREE.Mesh(
    new THREE.BoxGeometry(ft(0.08), ft(0.68), ft(5.2)),
    materials.panelLine,
  );
  panelBand.position.set(side * ft(engineRadiusFt * 1.045), ft(-0.4), ft(11.2));
  group.add(panelBand);

  const formationLight = new THREE.Mesh(
    new THREE.BoxGeometry(ft(0.045), ft(0.18), ft(2.5)),
    materials.yellow,
  );
  formationLight.position.set(side * ft(engineRadiusFt * 1.09), ft(0.03), ft(6.8));
  group.add(formationLight);

  return group;
}

function createEngineTunnel(material: THREE.Material) {
  const tunnel = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(22.5),
      frontWidth: ft(3.75),
      backWidth: ft(2.65),
      frontHeight: ft(0.54),
      backHeight: ft(0.34),
    }),
    material,
  );
  tunnel.position.set(0, ft(-1.08), ft(14.4));
  return tunnel;
}

function createBeaverTail(materials: F14Materials) {
  const group = new THREE.Group();
  const tail = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: -3.2, z: 17.2 },
        { x: 3.2, z: 17.2 },
        { x: 3.05, z: 27.2 },
        { x: 1.55, z: 31.0 },
        { x: -1.55, z: 31.0 },
        { x: -3.05, z: 27.2 },
      ],
      0.32,
      0,
    ),
    materials.upperPanel,
  );
  tail.position.y = ft(0.24);
  group.add(tail);

  const airbrake = createPlanformOverlay(
    [
      { x: -1.7, z: 20.0 },
      { x: 1.7, z: 20.0 },
      { x: 1.4, z: 26.1 },
      { x: -1.4, z: 26.1 },
    ],
    0,
    0.43,
    materials.panelLine,
  );
  group.add(airbrake);
  return group;
}

function createNozzle(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  group.position.set(side * ft(5.65), ft(-0.5), ft(30.6));

  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(1.52), ft(2.05), ft(2.45), 20, 1, true),
    materials.titanium,
  );
  outer.rotation.x = Math.PI / 2;
  group.add(outer);

  const liner = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(1.3), ft(1.82), ft(2.3), 20, 1, true),
    materials.nozzleDark,
  );
  liner.rotation.x = Math.PI / 2;
  group.add(liner);

  const burnerFace = new THREE.Mesh(new THREE.CircleGeometry(ft(1.2), 24), materials.intake);
  burnerFace.position.z = ft(-0.5);
  group.add(burnerFace);

  const innerRing = new THREE.Mesh(
    new THREE.TorusGeometry(ft(0.72), ft(0.1), 6, 24),
    materials.nozzleDark,
  );
  innerRing.position.z = ft(-0.43);
  group.add(innerRing);

  const tailRing = new THREE.Mesh(
    new THREE.TorusGeometry(ft(1.51), ft(0.08), 6, 30),
    materials.nozzleDark,
  );
  tailRing.position.z = ft(1.22);
  group.add(tailRing);

  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * TAU;
    group.add(
      createTube(
        [
          vft(Math.cos(angle) * 2.02, Math.sin(angle) * 2.02, -1.18),
          vft(Math.cos(angle) * 1.53, Math.sin(angle) * 1.53, 1.2),
        ],
        ft(0.028),
        materials.nozzleDark,
      ),
    );
  }

  return group;
}

function createAfterburner(side: -1 | 1, materials: F14Materials) {
  const burner = new THREE.Group();
  burner.position.set(side * ft(5.65), ft(-0.5), ft(33.1));

  const outer = new THREE.Mesh(
    new THREE.ConeGeometry(ft(1.18), ft(5.2), 18, 1, true),
    materials.flameOuter,
  );
  outer.rotation.x = Math.PI / 2;
  burner.add(outer);

  const inner = new THREE.Mesh(
    new THREE.ConeGeometry(ft(0.58), ft(3.9), 14, 1, true),
    materials.flameInner,
  );
  inner.rotation.x = Math.PI / 2;
  inner.position.z = ft(-0.18);
  burner.add(inner);
  burner.visible = false;
  return burner;
}

function createVerticalTail(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  group.position.set(side * ft(5.7), ft(0.72), ft(18.0));
  group.rotation.z = side * -0.13;

  const thickness = ft(0.38);
  const sx = thickness * 0.5;
  const positions: number[] = [];
  const left = [
    new THREE.Vector3(-sx, 0, ft(-3.1)),
    new THREE.Vector3(-sx, ft(0.18), ft(7.0)),
    new THREE.Vector3(-sx, ft(8.9), ft(5.25)),
    new THREE.Vector3(-sx, ft(10.35), ft(1.2)),
  ];
  const right = left.map((point) => point.clone().setX(sx));

  addPolygon(positions, left);
  addPolygon(positions, [...right].reverse());
  for (let i = 0; i < left.length; i += 1) {
    const next = (i + 1) % left.length;
    addQuad(positions, left[i], left[next], right[next], right[i]);
  }

  const tail = new THREE.Mesh(bufferGeometryFromPositions(positions), materials.paint);
  tail.castShadow = true;
  group.add(tail);

  const faceX = side * (sx + ft(0.012));
  const rudderPositions: number[] = [];
  addPolygon(rudderPositions, [
    new THREE.Vector3(faceX, ft(0.8), ft(5.45)),
    new THREE.Vector3(faceX, ft(1.05), ft(6.55)),
    new THREE.Vector3(faceX, ft(8.2), ft(4.92)),
    new THREE.Vector3(faceX, ft(8.8), ft(3.66)),
  ]);
  group.add(new THREE.Mesh(bufferGeometryFromPositions(rudderPositions), materials.upperPanel));

  const capPositions: number[] = [];
  addPolygon(capPositions, [
    new THREE.Vector3(faceX, ft(8.55), ft(4.86)),
    new THREE.Vector3(faceX, ft(8.92), ft(5.22)),
    new THREE.Vector3(faceX, ft(10.35), ft(1.2)),
    new THREE.Vector3(faceX, ft(9.72), ft(1.34)),
  ]);
  group.add(new THREE.Mesh(bufferGeometryFromPositions(capPositions), materials.darkPaint));

  const stripePositions: number[] = [];
  addQuad(
    stripePositions,
    new THREE.Vector3(faceX + side * ft(0.006), ft(7.66), ft(4.94)),
    new THREE.Vector3(faceX + side * ft(0.006), ft(7.94), ft(4.86)),
    new THREE.Vector3(faceX + side * ft(0.006), ft(9.0), ft(2.02)),
    new THREE.Vector3(faceX + side * ft(0.006), ft(8.72), ft(2.12)),
  );
  group.add(new THREE.Mesh(bufferGeometryFromPositions(stripePositions), materials.red));

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(0.045), ft(0.07), ft(0.62), 8),
    materials.darkPaint,
  );
  antenna.position.set(0, ft(10.56), ft(1.05));
  antenna.rotation.z = side * 0.08;
  group.add(antenna);
  return group;
}

function createStabilizer(side: -1 | 1, materials: F14Materials) {
  const group = new THREE.Group();
  group.position.set(side * ft(3.0), ft(-0.34), ft(24.2));
  group.rotation.y = side * -0.08;
  group.rotation.x = 0.025;

  const stabilizer = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: 0, z: -3.0 },
        { x: side * 10.85, z: 0.5 },
        { x: side * 10.5, z: 4.35 },
        { x: side * 0.4, z: 5.55 },
      ],
      0.36,
      0,
    ),
    materials.paint,
  );
  stabilizer.castShadow = true;
  group.add(stabilizer);

  const rearPanel = createPlanformOverlay(
    [
      { x: side * 1.0, z: 4.55 },
      { x: side * 9.72, z: 3.55 },
      { x: side * 9.96, z: 2.72 },
      { x: side * 1.05, z: 3.52 },
    ],
    0,
    0.2,
    materials.upperPanel,
  );
  group.add(rearPanel);

  const hinge = createTube(
    [vft(side * 1.05, 0.22, 3.45), vft(side * 9.95, 0.22, 2.66)],
    ft(0.032),
    materials.panelLine,
  );
  group.add(hinge);
  return group;
}

function createVentralFin(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * ft(4.55), ft(-1.35), ft(18.8));
  group.rotation.z = side * 0.05;

  const thickness = ft(0.26);
  const sx = thickness * 0.5;
  const positions: number[] = [];
  const a = new THREE.Vector3(-sx, 0, ft(-1.6));
  const b = new THREE.Vector3(-sx, ft(-1.72), ft(2.1));
  const c = new THREE.Vector3(-sx, 0, ft(5.7));
  const d = new THREE.Vector3(sx, 0, ft(-1.6));
  const e = new THREE.Vector3(sx, ft(-1.72), ft(2.1));
  const f = new THREE.Vector3(sx, 0, ft(5.7));

  addTriangle(positions, a, b, c);
  addTriangle(positions, f, e, d);
  addQuad(positions, a, d, e, b);
  addQuad(positions, b, e, f, c);
  addQuad(positions, c, f, d, a);

  const fin = new THREE.Mesh(bufferGeometryFromPositions(positions), material);
  group.add(fin);
  return group;
}

function createBellyOrdnance(materials: F14Materials) {
  const group = new THREE.Group();

  for (const x of [-1.22, 1.22]) {
    const rail = new THREE.Mesh(
      taperedBoxGeometry({
        length: ft(13.2),
        frontWidth: ft(0.48),
        backWidth: ft(0.42),
        frontHeight: ft(0.28),
        backHeight: ft(0.22),
      }),
      materials.darkPaint,
    );
    rail.position.set(ft(x), ft(-1.56), ft(2.6));
    rail.castShadow = true;
    group.add(rail);

    const missile = new THREE.Mesh(
      new THREE.CylinderGeometry(ft(0.5), ft(0.54), ft(11.8), 14),
      materials.white,
    );
    missile.rotation.x = Math.PI / 2;
    missile.position.set(ft(x), ft(-2.12), ft(2.5));
    missile.castShadow = true;
    group.add(missile);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(ft(0.5), ft(1.55), 14),
      materials.underside,
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(ft(x), ft(-2.12), ft(-4.18));
    group.add(nose);

    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(ft(0.548), ft(0.548), ft(0.18), 14),
      materials.yellow,
    );
    band.rotation.x = Math.PI / 2;
    band.position.set(ft(x), ft(-2.12), ft(-1.82));
    group.add(band);

    const horizontalFins = new THREE.Mesh(
      new THREE.BoxGeometry(ft(2.25), ft(0.1), ft(1.55)),
      materials.white,
    );
    horizontalFins.position.set(ft(x), ft(-2.12), ft(7.72));
    const verticalFins = new THREE.Mesh(
      new THREE.BoxGeometry(ft(0.1), ft(2.1), ft(1.55)),
      materials.white,
    );
    verticalFins.position.set(ft(x), ft(-2.12), ft(7.72));
    group.add(horizontalFins, verticalFins);
  }

  return group;
}

function createNoseDetails(materials: F14Materials) {
  const group = new THREE.Group();
  group.add(createChinPod(materials), createPitotProbe(materials.darkPaint));

  const gunPort = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(0.13), ft(0.13), ft(0.58), 10, 1, true),
    materials.intake,
  );
  gunPort.rotation.x = Math.PI / 2;
  gunPort.position.set(ft(-1.72), ft(0.38), ft(-21.2));
  group.add(gunPort);

  const antiGlare = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(4.4),
      frontWidth: ft(0.62),
      backWidth: ft(1.48),
      frontHeight: ft(0.05),
      backHeight: ft(0.05),
    }),
    materials.darkPaint,
  );
  antiGlare.position.set(0, ft(1.67), ft(-22.55));
  antiGlare.rotation.x = -0.035;
  group.add(antiGlare);
  return group;
}

function createChinPod(materials: F14Materials) {
  const group = new THREE.Group();
  const pod = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(0.34), ft(0.46), ft(1.25), 10, 1),
    materials.darkPaint,
  );
  pod.rotation.x = Math.PI / 2;
  pod.position.set(ft(0.18), ft(-1.22), ft(-23.7));

  const lens = new THREE.Mesh(new THREE.CircleGeometry(ft(0.24), 12), materials.glass);
  lens.position.set(ft(0.18), ft(-1.22), ft(-24.34));
  lens.rotation.y = Math.PI;
  group.add(pod, lens);
  return group;
}

function createPitotProbe(material: THREE.Material) {
  const probe = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(0.035), ft(0.055), ft(1.7), 6, 1),
    material,
  );
  probe.rotation.x = Math.PI / 2;
  probe.position.set(0, ft(0.03), ft(-F14_DIMENSIONS.lengthFt / 2 - 0.82));
  return probe;
}

function createPlanformOverlay(
  points: PlanformPoint[],
  dihedralDeg: number,
  elevationFt: number,
  material: THREE.Material,
) {
  const overlay = new THREE.Mesh(
    planformPrismGeometry(points, 0.025, dihedralDeg),
    material,
  );
  overlay.position.y = ft(elevationFt);
  return overlay;
}

function createTube(
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
) {
  const curve: THREE.Curve<THREE.Vector3> =
    points.length === 2
      ? new THREE.LineCurve3(points[0], points[1])
      : new THREE.CatmullRomCurve3(points, false, "centripetal");
  return new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(3, (points.length - 1) * 8), radius, 6, false),
    material,
  );
}

function createNationalInsignia() {
  const group = new THREE.Group();
  const blue = new THREE.MeshStandardMaterial({
    color: 0x203c5d,
    roughness: 0.76,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xf0eee3,
    roughness: 0.74,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });

  const bar = new THREE.Mesh(new THREE.PlaneGeometry(ft(3.8), ft(0.72)), blue);
  bar.rotation.x = -Math.PI / 2;
  group.add(bar);

  const circle = new THREE.Mesh(new THREE.CircleGeometry(ft(0.96), 24), blue);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = ft(0.012);
  group.add(circle);

  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i += 1) {
    const radius = ft(i % 2 === 0 ? 0.74 : 0.3);
    const angle = -Math.PI / 2 + (i / 10) * TAU;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) {
      starShape.moveTo(x, y);
    } else {
      starShape.lineTo(x, y);
    }
  }
  starShape.closePath();
  const star = new THREE.Mesh(new THREE.ShapeGeometry(starShape), white);
  star.rotation.x = -Math.PI / 2;
  star.position.y = ft(0.024);
  group.add(star);
  return group;
}

function planformPrismGeometry(
  points: PlanformPoint[],
  thicknessFt: number,
  dihedralDeg: number,
) {
  const slope = Math.tan(THREE.MathUtils.degToRad(dihedralDeg));
  const top = points.map((point) => {
    const y = Math.abs(point.x) * slope + thicknessFt * 0.5;
    return vft(point.x, y, point.z);
  });
  const bottom = points.map((point) => {
    const y = Math.abs(point.x) * slope - thicknessFt * 0.5;
    return vft(point.x, y, point.z);
  });
  const positions: number[] = [];

  addPolygon(positions, top);
  addPolygon(positions, [...bottom].reverse());

  for (let i = 0; i < top.length; i += 1) {
    const next = (i + 1) % top.length;
    addQuad(positions, top[i], top[next], bottom[next], bottom[i]);
  }

  return bufferGeometryFromPositions(positions);
}

function shoulderFairingGeometry(
  side: -1 | 1,
  rows: ShoulderRow[],
  thicknessFt: number,
) {
  const topInner = rows.map((row) => vft(side * row.innerX, row.innerY, row.z));
  const topOuter = rows.map((row) => vft(side * row.outerX, row.outerY, row.z));
  const bottomInner = rows.map((row) => vft(side * row.innerX, row.innerY - thicknessFt, row.z));
  const bottomOuter = rows.map((row) => vft(side * row.outerX, row.outerY - thicknessFt, row.z));
  const positions: number[] = [];

  for (let i = 0; i < rows.length - 1; i += 1) {
    const next = i + 1;
    addQuad(positions, topInner[i], topInner[next], topOuter[next], topOuter[i]);
    addQuad(positions, bottomInner[next], bottomInner[i], bottomOuter[i], bottomOuter[next]);
    addQuad(positions, topInner[next], topInner[i], bottomInner[i], bottomInner[next]);
    addQuad(positions, topOuter[i], topOuter[next], bottomOuter[next], bottomOuter[i]);
  }

  addQuad(positions, topInner[0], topOuter[0], bottomOuter[0], bottomInner[0]);
  const last = rows.length - 1;
  addQuad(positions, topOuter[last], topInner[last], bottomInner[last], bottomOuter[last]);

  return bufferGeometryFromPositions(positions);
}

function intakeDuctGeometry(stations: IntakeDuctStation[], side: -1 | 1) {
  const profiles = stations.map((station) => intakeProfileFromStation(station, side));
  const positions: number[] = [];

  for (let i = 0; i < profiles.length - 1; i += 1) {
    const current = profiles[i];
    const nextProfile = profiles[i + 1];
    for (let j = 0; j < current.length; j += 1) {
      const next = (j + 1) % current.length;
      addQuad(positions, current[j], current[next], nextProfile[next], nextProfile[j]);
    }
  }

  addPolygon(positions, profiles[profiles.length - 1]);
  return bufferGeometryFromPositions(positions);
}

function intakeSectionGeometry(station: IntakeDuctStation, side: -1 | 1) {
  const positions: number[] = [];
  addPolygon(positions, intakeProfileFromStation(station, side));
  return bufferGeometryFromPositions(positions);
}

function intakeLipGeometry(
  outer: IntakeDuctStation,
  inner: IntakeDuctStation,
  side: -1 | 1,
) {
  const outerPoints = intakeProfileCoordinates(outer);
  const innerPoints = intakeProfileCoordinates(inner);
  const shape = new THREE.Shape();

  outerPoints.forEach((point, index) => {
    if (index === 0) {
      shape.moveTo(point.x, point.y);
    } else {
      shape.lineTo(point.x, point.y);
    }
  });
  shape.closePath();

  const hole = new THREE.Path();
  [...innerPoints].reverse().forEach((point, index) => {
    if (index === 0) {
      hole.moveTo(point.x, point.y);
    } else {
      hole.lineTo(point.x, point.y);
    }
  });
  hole.closePath();
  shape.holes.push(hole);

  const geometry = new THREE.ShapeGeometry(shape);
  const position = geometry.getAttribute("position");
  const maxHalfWidth = Math.max(outer.topWidth, outer.bottomWidth) * 0.5;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const normalizedX = (x - outer.centerX) / maxHalfWidth;
    const z = outer.z + side * normalizedX * outer.skew * 0.5;
    position.setXYZ(i, ft(x), ft(y), ft(z));
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function intakeProfileCoordinates(station: IntakeDuctStation) {
  const topHalf = station.topWidth * 0.5;
  const bottomHalf = station.bottomWidth * 0.5;
  const corner = Math.min(
    station.corner,
    topHalf * 0.32,
    bottomHalf * 0.32,
    (station.top - station.bottom) * 0.18,
  );
  const sideMid = (station.top + station.bottom) * 0.5;
  const sideBulge = Math.max(topHalf, bottomHalf) + corner * 0.14;

  return [
    { x: station.centerX - topHalf + corner, y: station.top },
    { x: station.centerX + topHalf - corner, y: station.top },
    { x: station.centerX + topHalf, y: station.top - corner },
    { x: station.centerX + sideBulge, y: sideMid },
    { x: station.centerX + bottomHalf, y: station.bottom + corner },
    { x: station.centerX + bottomHalf - corner, y: station.bottom },
    { x: station.centerX - bottomHalf + corner, y: station.bottom },
    { x: station.centerX - bottomHalf, y: station.bottom + corner },
    { x: station.centerX - sideBulge, y: sideMid },
    { x: station.centerX - topHalf, y: station.top - corner },
  ];
}

function intakeProfileFromStation(station: IntakeDuctStation, side: -1 | 1) {
  const maxHalfWidth = Math.max(station.topWidth, station.bottomWidth) * 0.5;
  return intakeProfileCoordinates(station).map((point) => {
    const normalizedX = (point.x - station.centerX) / maxHalfWidth;
    const z = station.z + side * normalizedX * station.skew * 0.5;
    return vft(point.x, point.y, z);
  });
}

function taperedBoxGeometry({
  length,
  frontWidth,
  backWidth,
  frontHeight,
  backHeight,
}: {
  length: number;
  frontWidth: number;
  backWidth: number;
  frontHeight: number;
  backHeight: number;
}) {
  const fz = -length / 2;
  const bz = length / 2;
  const fw = frontWidth / 2;
  const bw = backWidth / 2;
  const fh = frontHeight / 2;
  const bh = backHeight / 2;

  const v = {
    ftl: new THREE.Vector3(-fw, fh, fz),
    ftr: new THREE.Vector3(fw, fh, fz),
    fbr: new THREE.Vector3(fw, -fh, fz),
    fbl: new THREE.Vector3(-fw, -fh, fz),
    btl: new THREE.Vector3(-bw, bh, bz),
    btr: new THREE.Vector3(bw, bh, bz),
    bbr: new THREE.Vector3(bw, -bh, bz),
    bbl: new THREE.Vector3(-bw, -bh, bz),
  };
  const positions: number[] = [];

  addQuad(positions, v.ftl, v.ftr, v.fbr, v.fbl);
  addQuad(positions, v.btr, v.btl, v.bbl, v.bbr);
  addQuad(positions, v.ftl, v.btl, v.btr, v.ftr);
  addQuad(positions, v.fbl, v.fbr, v.bbr, v.bbl);
  addQuad(positions, v.ftr, v.btr, v.bbr, v.fbr);
  addQuad(positions, v.btl, v.ftl, v.fbl, v.bbl);

  return bufferGeometryFromPositions(positions);
}
