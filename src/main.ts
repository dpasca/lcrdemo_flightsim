import * as THREE from "three";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#sim");

if (!canvas) {
  throw new Error("Missing #sim canvas");
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x83c9df);
scene.fog = new THREE.FogExp2(0x9ec8d1, 0.000055);

const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  0.4,
  90000,
);

const hemiLight = new THREE.HemisphereLight(0xc7edf2, 0x4b4538, 1.85);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xffe0a1, 4.7);
sun.position.set(-580, 940, 360);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 3600;
sun.shadow.camera.left = -1750;
sun.shadow.camera.right = 1750;
sun.shadow.camera.top = 1750;
sun.shadow.camera.bottom = -1750;
scene.add(sun);
scene.add(sun.target);

type FlightState = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  angularVelocity: THREE.Vector3;
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  speed: number;
};

type Inputs = {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  pointerPitch: number;
  pointerRoll: number;
};

declare global {
  interface Window {
    __f14Sim?: {
      renderer: THREE.WebGLRenderer;
      scene: THREE.Scene;
      camera: THREE.PerspectiveCamera;
      flight: FlightState;
      pause: () => void;
      resume: () => void;
    };
  }
}

const flight: FlightState = {
  position: new THREE.Vector3(0, 520, 1200),
  quaternion: new THREE.Quaternion(),
  angularVelocity: new THREE.Vector3(),
  pitch: THREE.MathUtils.degToRad(-1),
  yaw: THREE.MathUtils.degToRad(180),
  roll: 0,
  throttle: 0.58,
  speed: 330,
};

const input: Inputs = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  pointerPitch: 0,
  pointerRoll: 0,
};

const clock = new THREE.Clock();
let running = true;
let animationFrameId = 0;
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const localPitchAxis = new THREE.Vector3(1, 0, 0);
const localYawAxis = new THREE.Vector3(0, 1, 0);
const localRollAxis = new THREE.Vector3(0, 0, 1);
const worldYawAxis = new THREE.Vector3(0, 1, 0);
const localRotation = new THREE.Quaternion();
const attitudeEuler = new THREE.Euler(0, 0, 0, "YXZ");
const cameraTarget = new THREE.Vector3();
const cameraDesired = new THREE.Vector3();

type ViewMode = "chase" | "orbit";
const view: {
  mode: ViewMode;
  azimuth: number;
  elevation: number;
  radius: number;
  targetPos: THREE.Vector3;
  dragging: boolean;
  pointerId: number;
  lastX: number;
  lastY: number;
} = {
  mode: "chase",
  azimuth: Math.PI * 0.25,
  elevation: 0.32,
  radius: 46,
  targetPos: new THREE.Vector3(),
  dragging: false,
  pointerId: -1,
  lastX: 0,
  lastY: 0,
};

syncQuaternionFromFlightAngles();

const speedEl = mustElement("#speed");
const altitudeEl = mustElement("#altitude");
const throttleEl = mustElement("#throttle");
const bankEl = mustElement("#bank");
const headingEl = mustElement("#heading");
const lodEl = mustElement("#lod");
const throttleFillEl = mustElement("#throttle-fill");
const stickDotEl = mustElement("#stick-dot");
const viewBadgeEl = mustElement("#view-badge");

const aircraft = createF14();
scene.add(aircraft.root);

const terrain = createTerrainSystem();
scene.add(terrain.group);

if (import.meta.env.DEV) {
  window.__f14Sim = {
    renderer,
    scene,
    camera,
    flight,
    pause: () => {
      running = false;
      cancelAnimationFrame(animationFrameId);
      renderer.render(scene, camera);
    },
    resume: () => {
      if (running) {
        return;
      }

      running = true;
      clock.getDelta();
      tick();
    },
  };
}

const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(90000, 90000, 1, 1),
  new THREE.MeshStandardMaterial({
    color: 0x1d5a78,
    roughness: 0.83,
    metalness: 0.06,
    transparent: true,
    opacity: 0.82,
  }),
);
sea.rotation.x = -Math.PI / 2;
sea.position.y = -52;
sea.receiveShadow = true;
scene.add(sea);

const horizonGrid = createHorizonMarkers();
scene.add(horizonGrid);

const keys = new Set<string>();
const pointer = {
  active: false,
  id: -1,
  startX: 0,
  startY: 0,
};

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyV" && !event.repeat) {
    toggleViewMode();
    return;
  }
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);

  if (view.mode === "orbit") {
    view.dragging = true;
    view.pointerId = event.pointerId;
    view.lastX = event.clientX;
    view.lastY = event.clientY;
    return;
  }

  pointer.active = true;
  pointer.id = event.pointerId;
  pointer.startX = event.clientX;
  pointer.startY = event.clientY;
});

canvas.addEventListener("pointermove", (event) => {
  if (view.mode === "orbit" && view.dragging && event.pointerId === view.pointerId) {
    const dx = event.clientX - view.lastX;
    const dy = event.clientY - view.lastY;
    view.lastX = event.clientX;
    view.lastY = event.clientY;
    view.azimuth -= dx * 0.0065;
    view.elevation = THREE.MathUtils.clamp(view.elevation + dy * 0.0065, -0.45, 1.35);
    return;
  }

  if (!pointer.active || event.pointerId !== pointer.id) {
    return;
  }

  input.pointerRoll = THREE.MathUtils.clamp(
    (event.clientX - pointer.startX) / Math.max(window.innerWidth * 0.22, 120),
    -1,
    1,
  );
  input.pointerPitch = THREE.MathUtils.clamp(
    (event.clientY - pointer.startY) / Math.max(window.innerHeight * 0.22, 120),
    -1,
    1,
  );
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId === view.pointerId) {
    view.dragging = false;
  }

  if (view.mode === "orbit") {
    return;
  }

  if (event.pointerId !== pointer.id) {
    return;
  }

  pointer.active = false;
  input.pointerPitch = 0;
  input.pointerRoll = 0;
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();

    if (view.mode === "orbit") {
      view.radius = THREE.MathUtils.clamp(
        view.radius + event.deltaY * 0.04,
        12,
        220,
      );
      return;
    }

    flight.throttle = THREE.MathUtils.clamp(
      flight.throttle - event.deltaY * 0.00075,
      0,
      1,
    );
  },
  { passive: false },
);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
});

tick();

function tick() {
  if (!running) {
    return;
  }

  const delta = Math.min(clock.getDelta(), 0.045);
  updateInput(delta);

  if (view.mode === "chase") {
    updateFlight(delta);
    updateAircraft(delta);
  } else {
    updateAircraft(delta);
  }

  terrain.update(flight.position);
  updateCamera(delta, view.mode);
  updateHud();
  renderer.render(scene, camera);
  animationFrameId = requestAnimationFrame(tick);
}

function updateInput(delta: number) {
  const pitchKeys =
    (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0) -
    (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0);
  const rollKeys =
    (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) -
    (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
  const yawKeys =
    (keys.has("KeyE") ? 1 : 0) -
    (keys.has("KeyQ") ? 1 : 0);
  const throttleKeys =
    (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1 : 0) -
    (keys.has("ControlLeft") || keys.has("ControlRight") ? 1 : 0);

  input.pitch = damp(input.pitch, pitchKeys + input.pointerPitch * 0.85, 8, delta);
  input.roll = damp(input.roll, rollKeys + input.pointerRoll * 0.95, 9, delta);
  input.yaw = damp(input.yaw, yawKeys, 7, delta);
  input.throttle = throttleKeys;
}

function updateFlight(delta: number) {
  flight.throttle = THREE.MathUtils.clamp(
    flight.throttle + input.throttle * delta * 0.42,
    0,
    1,
  );

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);

  const targetSpeed = THREE.MathUtils.lerp(190, 760, flight.throttle);
  const diveAssist = THREE.MathUtils.clamp(-forward.y, -0.35, 0.35) * 95;
  flight.speed = damp(flight.speed, targetSpeed + diveAssist, 0.82, delta);

  const authority = THREE.MathUtils.clamp((flight.speed - 140) / 430, 0.28, 1.2);
  flight.angularVelocity.x = damp(
    flight.angularVelocity.x,
    input.pitch * 1.08 * authority,
    7,
    delta,
  );
  flight.angularVelocity.y = damp(
    flight.angularVelocity.y,
    input.yaw * 0.58 * authority,
    6,
    delta,
  );
  flight.angularVelocity.z = damp(
    flight.angularVelocity.z,
    input.roll * 2.25 * authority,
    8,
    delta,
  );

  applyLocalRotation(localPitchAxis, flight.angularVelocity.x * delta);
  applyLocalRotation(localYawAxis, -flight.angularVelocity.y * delta);
  applyLocalRotation(localRollAxis, -flight.angularVelocity.z * delta);
  syncFlightAnglesFromQuaternion();

  right.set(1, 0, 0).applyQuaternion(flight.quaternion);
  const bankTurn = -right.y * 0.52 * authority;
  applyWorldRotation(worldYawAxis, -bankTurn * delta);
  syncFlightAnglesFromQuaternion();

  const ground = heightAt(flight.position.x, flight.position.z) + 72;

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  flight.position.addScaledVector(forward, flight.speed * delta);

  if (flight.position.y < ground) {
    flight.position.y = ground;
    flight.speed = Math.max(flight.speed * 0.965, 190);
    flight.angularVelocity.x = Math.max(flight.angularVelocity.x, 0);
  }
}

function updateAircraft(delta: number) {
  aircraft.root.position.copy(flight.position);
  aircraft.root.quaternion.copy(flight.quaternion);

  const sweep = THREE.MathUtils.mapLinear(
    THREE.MathUtils.clamp(flight.speed, 250, 700),
    250,
    700,
    0.14,
    0.72,
  );
  aircraft.leftWing.rotation.y = sweep;
  aircraft.rightWing.rotation.y = -sweep;

  const nozzleScale = THREE.MathUtils.lerp(0.78, 1.15, flight.throttle);
  aircraft.leftNozzle.scale.setScalar(nozzleScale);
  aircraft.rightNozzle.scale.setScalar(nozzleScale);
  aircraft.afterburnerLeft.visible = flight.throttle > 0.82;
  aircraft.afterburnerRight.visible = aircraft.afterburnerLeft.visible;
  aircraft.afterburnerLeft.scale.z = damp(
    aircraft.afterburnerLeft.scale.z,
    0.75 + flight.throttle * 1.4,
    12,
    delta,
  );
  aircraft.afterburnerRight.scale.z = aircraft.afterburnerLeft.scale.z;
}

function updateCamera(delta: number, mode: ViewMode) {
  if (mode === "orbit") {
    const cosE = Math.cos(view.elevation);
    const sinE = Math.sin(view.elevation);
    const cosA = Math.cos(view.azimuth);
    const sinA = Math.sin(view.azimuth);

    cameraDesired.set(
      view.targetPos.x + view.radius * cosE * sinA,
      view.targetPos.y + view.radius * sinE,
      view.targetPos.z + view.radius * cosE * cosA,
    );
    camera.position.lerp(cameraDesired, 1 - Math.exp(-delta * 8));
    cameraTarget.copy(view.targetPos);
    camera.lookAt(cameraTarget);

    sun.target.position.copy(view.targetPos);
    sun.position.copy(view.targetPos).add(new THREE.Vector3(-580, 940, 360));
    return;
  }

  const chaseDistance = THREE.MathUtils.lerp(58, 88, flight.speed / 760);
  const cameraHeight = THREE.MathUtils.lerp(15, 25, flight.speed / 760);

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);

  cameraDesired
    .copy(flight.position)
    .addScaledVector(forward, -chaseDistance)
    .addScaledVector(worldYawAxis, cameraHeight);
  camera.position.lerp(cameraDesired, 1 - Math.exp(-delta * 4.2));

  cameraTarget
    .copy(flight.position)
    .addScaledVector(forward, 118)
    .addScaledVector(worldYawAxis, 3);
  camera.up.copy(worldYawAxis);
  camera.lookAt(cameraTarget);

  sun.target.position.copy(flight.position);
  sun.position.copy(flight.position).add(new THREE.Vector3(-580, 940, 360));
}

function toggleViewMode() {
  if (view.mode === "chase") {
    view.mode = "orbit";
    view.targetPos.copy(flight.position);
    view.azimuth = flight.yaw;
    view.elevation = 0.22;
    view.radius = 46;
    pointer.active = false;
    input.pointerPitch = 0;
    input.pointerRoll = 0;
  } else {
    view.mode = "chase";
    view.dragging = false;
  }
  viewBadgeEl.textContent = view.mode === "chase" ? "CHASE" : "ORBIT";
  viewBadgeEl.dataset.mode = view.mode;
}

function updateHud() {
  const altitude = Math.max(0, flight.position.y - heightAt(flight.position.x, flight.position.z));
  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  const headingDegrees = positiveDegrees(Math.atan2(-forward.x, forward.z));

  speedEl.textContent = Math.round(flight.speed).toString().padStart(3, "0");
  altitudeEl.textContent = Math.round(altitude).toString().padStart(4, "0");
  throttleEl.textContent = `${Math.round(flight.throttle * 100)
    .toString()
    .padStart(2, "0")}%`;
  bankEl.textContent = Math.round(THREE.MathUtils.radToDeg(flight.roll))
    .toString()
    .padStart(2, "0");
  headingEl.textContent = Math.round(headingDegrees).toString().padStart(3, "0");
  lodEl.textContent = terrain.activeBands.toString();
  throttleFillEl.style.height = `${flight.throttle * 100}%`;
  stickDotEl.style.transform = `translate(${input.pointerRoll * 42}px, ${
    input.pointerPitch * 42
  }px)`;
}

function createF14() {
  const root = new THREE.Group();
  root.name = "Procedural low-poly F-14 Tomcat";
  root.scale.setScalar(4.5);

  const paint = new THREE.MeshStandardMaterial({
    color: 0xa9adb0,
    roughness: 0.78,
    metalness: 0.15,
    flatShading: true,
  });
  const darkPaint = new THREE.MeshStandardMaterial({
    color: 0x4a5361,
    roughness: 0.82,
    metalness: 0.18,
    flatShading: true,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x213a54,
    roughness: 0.42,
    metalness: 0.22,
    emissive: 0x07131d,
    flatShading: true,
  });
  const intakeMat = new THREE.MeshStandardMaterial({
    color: 0x232936,
    roughness: 0.9,
    metalness: 0.08,
    flatShading: true,
  });
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xff9a2f,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  const fuselage = new THREE.Mesh(
    taperedBoxGeometry({
      length: 7.6,
      frontWidth: 0.72,
      backWidth: 1.68,
      frontHeight: 0.54,
      backHeight: 0.92,
    }),
    paint,
  );
  fuselage.position.z = 0.75;
  fuselage.castShadow = true;
  root.add(fuselage);

  const spine = new THREE.Mesh(
    taperedBoxGeometry({
      length: 4.6,
      frontWidth: 0.52,
      backWidth: 1.08,
      frontHeight: 0.22,
      backHeight: 0.36,
    }),
    darkPaint,
  );
  spine.position.set(0, 0.56, 0.9);
  spine.castShadow = true;
  root.add(spine);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.48, 3.25, 5, 1), paint);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -4.65;
  nose.castShadow = true;
  root.add(nose);

  const canopy = new THREE.Mesh(canopyGeometry(), canopyMat);
  canopy.position.set(0, 0.76, -2.4);
  canopy.castShadow = true;
  root.add(canopy);

  const neck = new THREE.Mesh(
    taperedBoxGeometry({
      length: 1.6,
      frontWidth: 0.7,
      backWidth: 1.55,
      frontHeight: 0.48,
      backHeight: 0.72,
    }),
    paint,
  );
  neck.position.set(0, 0.03, -1.45);
  neck.castShadow = true;
  root.add(neck);

  const leftWing = createWing(-1, paint);
  const rightWing = createWing(1, paint);
  root.add(leftWing, rightWing);

  const leftIntake = createIntake(-1, intakeMat, paint);
  const rightIntake = createIntake(1, intakeMat, paint);
  root.add(leftIntake, rightIntake);

  const nacelles = [-1, 1].map((side) => {
    const nacelle = new THREE.Mesh(
      taperedBoxGeometry({
        length: 5.7,
        frontWidth: 0.62,
        backWidth: 0.82,
        frontHeight: 0.54,
        backHeight: 0.68,
      }),
      darkPaint,
    );
    nacelle.position.set(side * 0.72, -0.16, 1.55);
    nacelle.castShadow = true;
    root.add(nacelle);
    return nacelle;
  });

  const leftNozzle = createNozzle(-1);
  const rightNozzle = createNozzle(1);
  root.add(leftNozzle, rightNozzle);

  const afterburnerLeft = createAfterburner(-1, flameMat);
  const afterburnerRight = createAfterburner(1, flameMat);
  root.add(afterburnerLeft, afterburnerRight);

  const tailLeft = createVerticalTail(-1, paint);
  const tailRight = createVerticalTail(1, paint);
  root.add(tailLeft, tailRight);

  const stabilizerLeft = createStabilizer(-1, paint);
  const stabilizerRight = createStabilizer(1, paint);
  root.add(stabilizerLeft, stabilizerRight);

  const bellyRails = createBellyOrdnance(paint, darkPaint);
  root.add(bellyRails);

  for (const part of root.children) {
    part.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
    });
  }

  return {
    root,
    leftWing,
    rightWing,
    leftNozzle,
    rightNozzle,
    afterburnerLeft,
    afterburnerRight,
    nacelles,
  };
}

function createWing(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * 0.55, -0.03, -0.32);

  const thickness = 0.08;
  const sx = side;
  const top = thickness * 0.5;
  const bottom = -thickness * 0.5;
  const pointsTop: THREE.Vector3[] = [
    new THREE.Vector3(0, top, -0.72),
    new THREE.Vector3(sx * 4.85, top, -0.1),
    new THREE.Vector3(sx * 5.55, top, 0.62),
    new THREE.Vector3(sx * 0.24, top, 2.35),
  ];
  const pointsBottom = pointsTop.map((point) => point.clone().setY(bottom));
  const positions: number[] = [];

  addQuad(positions, pointsTop[0], pointsTop[1], pointsTop[2], pointsTop[3]);
  addQuad(positions, pointsBottom[3], pointsBottom[2], pointsBottom[1], pointsBottom[0]);

  for (let i = 0; i < pointsTop.length; i += 1) {
    const next = (i + 1) % pointsTop.length;
    addQuad(
      positions,
      pointsTop[i],
      pointsTop[next],
      pointsBottom[next],
      pointsBottom[i],
    );
  }

  const geometry = bufferGeometryFromPositions(positions);
  const wing = new THREE.Mesh(geometry, material);
  wing.castShadow = true;
  group.add(wing);

  const glove = new THREE.Mesh(
    taperedBoxGeometry({
      length: 1.9,
      frontWidth: 1.1,
      backWidth: 1.72,
      frontHeight: 0.16,
      backHeight: 0.18,
    }),
    material,
  );
  glove.position.set(side * 0.36, 0.04, 0.56);
  glove.rotation.z = side * -0.08;
  glove.castShadow = true;
  group.add(glove);

  return group;
}

function createIntake(
  side: -1 | 1,
  intakeMaterial: THREE.Material,
  bodyMaterial: THREE.Material,
) {
  const group = new THREE.Group();
  group.position.set(side * 1.02, -0.22, -0.95);

  const scoop = new THREE.Mesh(
    taperedBoxGeometry({
      length: 1.7,
      frontWidth: 0.82,
      backWidth: 0.55,
      frontHeight: 0.64,
      backHeight: 0.46,
    }),
    bodyMaterial,
  );
  scoop.castShadow = true;
  group.add(scoop);

  const mouth = new THREE.Mesh(
    taperedBoxGeometry({
      length: 0.16,
      frontWidth: 0.72,
      backWidth: 0.72,
      frontHeight: 0.45,
      backHeight: 0.45,
    }),
    intakeMaterial,
  );
  mouth.position.z = -0.91;
  mouth.castShadow = true;
  group.add(mouth);

  return group;
}

function createNozzle(side: -1 | 1) {
  const material = new THREE.MeshStandardMaterial({
    color: 0x20242b,
    roughness: 0.72,
    metalness: 0.34,
    flatShading: true,
  });
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.58, 8, 1), material);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(side * 0.72, -0.15, 4.72);
  nozzle.castShadow = true;
  return nozzle;
}

function createAfterburner(side: -1 | 1, material: THREE.Material) {
  const burner = new THREE.Mesh(new THREE.ConeGeometry(0.24, 1.4, 8, 1), material);
  burner.rotation.x = Math.PI / 2;
  burner.position.set(side * 0.72, -0.15, 5.38);
  burner.visible = false;
  return burner;
}

function createVerticalTail(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * 0.86, 0.28, 3.05);
  group.rotation.z = side * -0.18;

  const thickness = 0.08;
  const sx = side * thickness * 0.5;
  const positions: number[] = [];
  const a = new THREE.Vector3(-sx, 0, -0.15);
  const b = new THREE.Vector3(-sx, 0.08, 1.56);
  const c = new THREE.Vector3(-sx, 1.92, 0.92);
  const d = new THREE.Vector3(sx, 0, -0.15);
  const e = new THREE.Vector3(sx, 0.08, 1.56);
  const f = new THREE.Vector3(sx, 1.92, 0.92);

  addTriangle(positions, a, b, c);
  addTriangle(positions, f, e, d);
  addQuad(positions, a, d, e, b);
  addQuad(positions, b, e, f, c);
  addQuad(positions, c, f, d, a);

  const tail = new THREE.Mesh(bufferGeometryFromPositions(positions), material);
  tail.castShadow = true;
  group.add(tail);
  return group;
}

function createStabilizer(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * 1.05, -0.05, 3.78);
  group.rotation.y = side * -0.28;
  group.rotation.x = 0.04;

  const thickness = 0.06;
  const sx = side;
  const top = thickness * 0.5;
  const bottom = -thickness * 0.5;
  const p: THREE.Vector3[] = [
    new THREE.Vector3(0, top, -0.34),
    new THREE.Vector3(sx * 2.1, top, 0.05),
    new THREE.Vector3(sx * 2.32, top, 0.8),
    new THREE.Vector3(0.05 * sx, top, 1.04),
  ];
  const q = p.map((point) => point.clone().setY(bottom));
  const positions: number[] = [];
  addQuad(positions, p[0], p[1], p[2], p[3]);
  addQuad(positions, q[3], q[2], q[1], q[0]);
  for (let i = 0; i < p.length; i += 1) {
    const next = (i + 1) % p.length;
    addQuad(positions, p[i], p[next], q[next], q[i]);
  }

  const stabilizer = new THREE.Mesh(bufferGeometryFromPositions(positions), material);
  stabilizer.castShadow = true;
  group.add(stabilizer);
  return group;
}

function createBellyOrdnance(
  bodyMaterial: THREE.Material,
  darkMaterial: THREE.Material,
) {
  const group = new THREE.Group();
  const railMaterial = darkMaterial;
  const missileMaterial = bodyMaterial;

  for (const x of [-0.38, 0.38]) {
    const rail = new THREE.Mesh(
      taperedBoxGeometry({
        length: 2.5,
        frontWidth: 0.12,
        backWidth: 0.12,
        frontHeight: 0.08,
        backHeight: 0.08,
      }),
      railMaterial,
    );
    rail.position.set(x, -0.64, 1.25);
    rail.castShadow = true;
    group.add(rail);

    const missile = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.65, 6), missileMaterial);
    missile.rotation.x = Math.PI / 2;
    missile.position.set(x, -0.8, 1.25);
    missile.castShadow = true;
    group.add(missile);
  }

  return group;
}

function canopyGeometry() {
  const positions: number[] = [];
  const front = -0.92;
  const back = 0.92;
  const halfFront = 0.24;
  const halfBack = 0.42;

  const p0 = new THREE.Vector3(-halfFront, 0, front);
  const p1 = new THREE.Vector3(halfFront, 0, front);
  const p2 = new THREE.Vector3(halfBack, 0, back);
  const p3 = new THREE.Vector3(-halfBack, 0, back);
  const ridgeFront = new THREE.Vector3(0, 0.42, front + 0.15);
  const ridgeBack = new THREE.Vector3(0, 0.34, back - 0.18);

  addTriangle(positions, p0, p1, ridgeFront);
  addTriangle(positions, p1, p2, ridgeBack);
  addTriangle(positions, p1, ridgeBack, ridgeFront);
  addTriangle(positions, p2, p3, ridgeBack);
  addTriangle(positions, p3, p0, ridgeFront);
  addTriangle(positions, p3, ridgeFront, ridgeBack);
  addQuad(positions, p0, p3, p2, p1);

  return bufferGeometryFromPositions(positions);
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

function createTerrainSystem() {
  const group = new THREE.Group();
  const levels = [
    { outer: 6800, inner: 0, segments: 56 },
    { outer: 26000, inner: 6800, segments: 44 },
    { outer: 86000, inner: 26000, segments: 34 },
  ];
  let anchorX = Number.POSITIVE_INFINITY;
  let anchorZ = Number.POSITIVE_INFINITY;
  let activeBands = 0;

  const update = (position: THREE.Vector3) => {
    const snap = 2400;
    const nextX = Math.round(position.x / snap) * snap;
    const nextZ = Math.round(position.z / snap) * snap;

    if (Math.abs(nextX - anchorX) < snap && Math.abs(nextZ - anchorZ) < snap) {
      return;
    }

    anchorX = nextX;
    anchorZ = nextZ;
    group.clear();

    for (const level of levels) {
      const patch = new THREE.Mesh(
        terrainGeometry(level.outer, level.inner, level.segments, anchorX, anchorZ),
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.95,
          metalness: 0.02,
          flatShading: true,
        }),
      );
      patch.receiveShadow = true;
      patch.castShadow = false;
      group.add(patch);
    }

    activeBands = levels.length;
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

  for (let ix = 0; ix < segments; ix += 1) {
    for (let iz = 0; iz < segments; iz += 1) {
      const x0 = -half + ix * step + offsetX;
      const z0 = -half + iz * step + offsetZ;
      const x1 = x0 + step;
      const z1 = z0 + step;
      const centerX = (x0 + x1) * 0.5 - offsetX;
      const centerZ = (z0 + z1) * 0.5 - offsetZ;

      if (innerSize > 0 && Math.abs(centerX) < innerHalf && Math.abs(centerZ) < innerHalf) {
        continue;
      }

      const p0 = terrainPoint(x0, z0);
      const p1 = terrainPoint(x1, z0);
      const p2 = terrainPoint(x1, z1);
      const p3 = terrainPoint(x0, z1);

      addTerrainTriangle(positions, colors, p0, p2, p1, offsetX, offsetZ);
      addTerrainTriangle(positions, colors, p2, p0, p3, offsetX, offsetZ);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
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

function heightAt(x: number, z: number) {
  const broad =
    Math.sin(x * 0.00055 + 1.7) * 90 +
    Math.cos(z * 0.00048 - 0.9) * 78 +
    Math.sin((x + z) * 0.00036) * 105;
  const ridges =
    Math.abs(Math.sin(x * 0.0012 + z * 0.0005)) * 82 +
    Math.abs(Math.cos(z * 0.0011 - x * 0.00022)) * 46;
  const plateau = Math.sin(x * 0.00012 - z * 0.00015) * 180;
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

  if (height < -42) {
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

function createHorizonMarkers() {
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
    const radius = 36000;
    marker.position.set(Math.cos(angle) * radius, 120, Math.sin(angle) * radius);
    marker.rotation.y = -angle;
    group.add(marker);
  }

  return group;
}

function addQuad(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
) {
  addTriangle(positions, a, b, c);
  addTriangle(positions, c, d, a);
}

function addTriangle(
  positions: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
) {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function bufferGeometryFromPositions(positions: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function damp(current: number, target: number, lambda: number, delta: number) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * delta));
}

function applyLocalRotation(axis: THREE.Vector3, radians: number) {
  if (Math.abs(radians) < 0.000001) {
    return;
  }

  localRotation.setFromAxisAngle(axis, radians);
  flight.quaternion.multiply(localRotation).normalize();
}

function applyWorldRotation(axis: THREE.Vector3, radians: number) {
  if (Math.abs(radians) < 0.000001) {
    return;
  }

  localRotation.setFromAxisAngle(axis, radians);
  flight.quaternion.premultiply(localRotation).normalize();
}

function syncQuaternionFromFlightAngles() {
  flight.quaternion.setFromEuler(
    attitudeEuler.set(flight.pitch, flight.yaw, -flight.roll, "YXZ"),
  );
}

function syncFlightAnglesFromQuaternion() {
  attitudeEuler.setFromQuaternion(flight.quaternion, "YXZ");
  flight.pitch = attitudeEuler.x;
  flight.yaw = attitudeEuler.y;
  flight.roll = -attitudeEuler.z;
}

function positiveDegrees(radians: number) {
  return ((THREE.MathUtils.radToDeg(radians) % 360) + 360) % 360;
}

function mustElement(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);

  if (!element) {
    throw new Error(`Missing ${selector} element`);
  }

  return element;
}
