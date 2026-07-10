import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#sim");

if (!canvas) {
  throw new Error("Missing #sim canvas");
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true,
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
scene.fog = new THREE.FogExp2(0x9ec8d1, 0.000046);

const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  2,
  108000,
);

const TAU = Math.PI * 2;
const SEA_LEVEL = -52;
const TERRAIN_SNAP_SIZE = 2400;
const TERRAIN_LEVELS = [
  { outer: 7200, inner: 0, segments: 62 },
  { outer: 28000, inner: 7200, segments: 48 },
  { outer: 76000, inner: 28000, segments: 40 },
  { outer: 154000, inner: 76000, segments: 30 },
] as const;
const WORLD_WRAP_RADIUS = 178000;
const WORLD_WRAP_SIZE = WORLD_WRAP_RADIUS * 2;
const MINIMAP_TEXTURE_SIZE = 128;
const MINIMAP_WORLD_SPAN = TERRAIN_LEVELS[TERRAIN_LEVELS.length - 1].outer;
const HUD_VIEWBOX_HALF_HEIGHT = 300;
const HUD_HEADING_PIXELS_PER_DEGREE = 6;
const CHASE_CAMERA_ROLL_RESPONSE = 3.2;

const hemiLight = new THREE.HemisphereLight(0xc7edf2, 0x4b4538, 1.85);
scene.add(hemiLight);

const ambientFill = new THREE.AmbientLight(0x78909a, 0.42);
scene.add(ambientFill);

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
const F14_WING_SWEEP_DELTA = THREE.MathUtils.degToRad(
  F14_DIMENSIONS.sweptLeadingEdgeDeg - F14_DIMENSIONS.unsweptLeadingEdgeDeg,
);

type FlightState = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  angularVelocity: THREE.Vector3;
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  speed: number;
  gForce: number;
  alpha: number;
};

type VerticalTapeParams = {
  tickStep: number;
  labelStep: number;
  pixelsPerUnit: number;
  side: "left" | "right";
  minValue: number;
  formatLabel: (value: number) => string;
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
  gForce: 1,
  alpha: 0,
};

const input: Inputs = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  pointerPitch: 0,
  pointerRoll: 0,
};

const SPEED_TAPE_PARAMS: VerticalTapeParams = {
  tickStep: 10,
  labelStep: 20,
  pixelsPerUnit: 1.48,
  side: "left",
  minValue: 0,
  formatLabel: (value) => Math.round(value).toString(),
};

const ALTITUDE_TAPE_PARAMS: VerticalTapeParams = {
  tickStep: 100,
  labelStep: 200,
  pixelsPerUnit: 0.22,
  side: "right",
  minValue: 0,
  formatLabel: (value) => Math.round(value).toString(),
};

const clock = new THREE.Clock();
let running = true;
let animationFrameId = 0;
let cameraRoll = 0;
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
const horizonRight = new THREE.Vector3();
const localPitchAxis = new THREE.Vector3(1, 0, 0);
const localYawAxis = new THREE.Vector3(0, 1, 0);
const localRollAxis = new THREE.Vector3(0, 0, 1);
const worldYawAxis = new THREE.Vector3(0, 1, 0);
const localRotation = new THREE.Quaternion();
const attitudeEuler = new THREE.Euler(0, 0, 0, "YXZ");
const cameraTarget = new THREE.Vector3();
const cameraDesired = new THREE.Vector3();
const wrapOffset = new THREE.Vector3();

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

const pitchLadderEl = mustElement<SVGGElement>("#pitch-ladder");
const speedTicksEl = mustElement<SVGGElement>("#speed-ticks");
const altitudeTicksEl = mustElement<SVGGElement>("#altitude-ticks");
const headingTicksEl = mustElement<SVGGElement>("#heading-ticks");
const bankPointerEl = mustElement<SVGGElement>("#bank-pointer");
const flightPathMarkerEl = mustElement<SVGGElement>("#flight-path-marker");
const speedEl = mustElement<SVGTextElement>("#speed");
const altitudeEl = mustElement<SVGTextElement>("#altitude");
const throttleEl = mustElement<SVGTextElement>("#throttle");
const bankEl = mustElement<SVGTextElement>("#bank");
const headingEl = mustElement<SVGTextElement>("#heading");
const lodEl = mustElement<SVGTextElement>("#lod");
const gForceEl = mustElement<SVGTextElement>("#gforce");
const alphaEl = mustElement<SVGTextElement>("#alpha");
const throttleFillEl = mustElement("#throttle-fill");
const stickDotEl = mustElement("#stick-dot");
const viewBadgeEl = mustElement("#view-badge");
const minimapCanvas = mustElement<HTMLCanvasElement>("#minimap");
const minimapContext = minimapCanvas.getContext("2d");
const minimapTerrainCanvas = document.createElement("canvas");
minimapTerrainCanvas.width = MINIMAP_TEXTURE_SIZE;
minimapTerrainCanvas.height = MINIMAP_TEXTURE_SIZE;
const minimapTerrainContext = minimapTerrainCanvas.getContext("2d");

if (!minimapContext || !minimapTerrainContext) {
  throw new Error("Missing minimap canvas context");
}

const minimapCtx = minimapContext;
const minimapTerrainCtx = minimapTerrainContext;

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
  new THREE.PlaneGeometry(220000, 220000, 1, 1),
  new THREE.MeshStandardMaterial({
    color: 0x1d5a78,
    roughness: 0.83,
    metalness: 0.06,
  }),
);
sea.rotation.x = -Math.PI / 2;
sea.position.y = SEA_LEVEL;
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
  }

  wrapWorldIfNeeded();
  updateAircraft(delta);
  terrain.update(flight.position);
  updateWorldAnchors();
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

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  flight.position.addScaledVector(forward, flight.speed * delta);

  const ground = heightAt(flight.position.x, flight.position.z) + 72;

  if (flight.position.y < ground) {
    flight.position.y = ground;
    flight.speed = Math.max(flight.speed * 0.965, 190);
    flight.angularVelocity.x = Math.max(flight.angularVelocity.x, 0);
  }

  const speedAuthority = THREE.MathUtils.clamp(flight.speed / 380, 0.35, 2.1);
  const pitchLoad = Math.abs(flight.angularVelocity.x) * speedAuthority;
  const bankLoad = Math.abs(Math.sin(flight.roll)) * 0.72;
  const pullLoad = input.pitch >= 0 ? input.pitch * 1.45 : input.pitch * 0.65;
  const targetG = THREE.MathUtils.clamp(1 + pitchLoad + bankLoad + pullLoad, 0.25, 8.5);
  const targetAlpha = THREE.MathUtils.clamp(
    input.pitch * 12.5 + flight.angularVelocity.x * 3.5 - forward.y * 2,
    -9,
    25,
  );

  flight.gForce = damp(flight.gForce, targetG, 5.5, delta);
  flight.alpha = damp(flight.alpha, targetAlpha, 6, delta);
}

function wrapWorldIfNeeded() {
  wrapOffset.set(0, 0, 0);

  if (flight.position.x > WORLD_WRAP_RADIUS) {
    wrapOffset.x = -WORLD_WRAP_SIZE;
  } else if (flight.position.x < -WORLD_WRAP_RADIUS) {
    wrapOffset.x = WORLD_WRAP_SIZE;
  }

  if (flight.position.z > WORLD_WRAP_RADIUS) {
    wrapOffset.z = -WORLD_WRAP_SIZE;
  } else if (flight.position.z < -WORLD_WRAP_RADIUS) {
    wrapOffset.z = WORLD_WRAP_SIZE;
  }

  if (wrapOffset.lengthSq() === 0) {
    return;
  }

  flight.position.add(wrapOffset);
  camera.position.add(wrapOffset);
  view.targetPos.add(wrapOffset);
}

function updateWorldAnchors() {
  sea.position.x = flight.position.x;
  sea.position.z = flight.position.z;
  horizonGrid.position.x = flight.position.x;
  horizonGrid.position.z = flight.position.z;
}

function updateAircraft(delta: number) {
  aircraft.root.position.copy(flight.position);
  aircraft.root.quaternion.copy(flight.quaternion);

  const sweep = THREE.MathUtils.mapLinear(
    THREE.MathUtils.clamp(flight.speed, 250, 700),
    250,
    700,
    0,
    F14_WING_SWEEP_DELTA,
  );
  aircraft.leftWing.rotation.y = sweep;
  aircraft.rightWing.rotation.y = -sweep;

  const nozzleScale = THREE.MathUtils.lerp(0.78, 1.15, flight.throttle);
  aircraft.leftNozzle.scale.set(nozzleScale, nozzleScale, 1);
  aircraft.rightNozzle.scale.set(nozzleScale, nozzleScale, 1);
  aircraft.afterburnerLeft.visible = flight.throttle > 0.82;
  aircraft.afterburnerRight.visible = aircraft.afterburnerLeft.visible;
  aircraft.afterburnerLeft.scale.z = damp(
    aircraft.afterburnerLeft.scale.z,
    0.75 + flight.throttle * 1.4,
    12,
    delta,
  );
  aircraft.afterburnerRight.scale.z = aircraft.afterburnerLeft.scale.z;

  const stabilatorPitch = input.pitch * 0.19;
  const stabilatorRoll = input.roll * 0.045;
  aircraft.stabilizerLeft.rotation.x = 0.025 + stabilatorPitch + stabilatorRoll;
  aircraft.stabilizerRight.rotation.x = 0.025 + stabilatorPitch - stabilatorRoll;
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
    camera.up.copy(worldYawAxis);
    camera.lookAt(cameraTarget);
    cameraRoll = dampAngle(cameraRoll, 0, 8, delta);

    sun.target.position.copy(view.targetPos);
    sun.position.copy(view.targetPos).add(new THREE.Vector3(-580, 940, 360));
    return;
  }

  const speedRatio = THREE.MathUtils.clamp(flight.speed / 760, 0, 1);
  const chaseDistance = THREE.MathUtils.lerp(50, 74, speedRatio);
  const cameraHeight = THREE.MathUtils.lerp(13, 21, speedRatio);

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);

  cameraDesired
    .copy(flight.position)
    .addScaledVector(forward, -chaseDistance)
    .addScaledVector(worldYawAxis, cameraHeight);
  camera.position.lerp(cameraDesired, 1 - Math.exp(-delta * 4.2));

  cameraTarget
    .copy(flight.position)
    .addScaledVector(forward, 104)
    .addScaledVector(worldYawAxis, 3);
  camera.up.copy(worldYawAxis);
  camera.lookAt(cameraTarget);
  cameraRoll = dampAngle(cameraRoll, -flight.roll, CHASE_CAMERA_ROLL_RESPONSE, delta);
  camera.rotateZ(cameraRoll);

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
  const rollDegrees = THREE.MathUtils.radToDeg(flight.roll);
  const cameraPitchDegrees = calcCameraPitchDegrees();
  const cameraHorizonRollDegrees = calcCameraHorizonRollDegrees();

  speedEl.textContent = Math.round(flight.speed).toString().padStart(3, "0");
  altitudeEl.textContent = Math.round(altitude).toString().padStart(5, "0");
  throttleEl.textContent = `THR ${Math.round(flight.throttle * 100)
    .toString()
    .padStart(2, "0")}%`;
  bankEl.textContent = formatBank(rollDegrees);
  headingEl.textContent = Math.round(headingDegrees).toString().padStart(3, "0");
  lodEl.textContent = `LOD ${terrain.activeBands}`;
  gForceEl.textContent = flight.gForce.toFixed(1);
  alphaEl.textContent = Math.round(flight.alpha).toString().padStart(2, "0");
  throttleFillEl.style.height = `${flight.throttle * 100}%`;
  stickDotEl.style.transform = `translate(${input.pointerRoll * 42}px, ${
    input.pointerPitch * 42
  }px)`;
  bankPointerEl.setAttribute("transform", `rotate(${svgNumber(rollDegrees)})`);
  flightPathMarkerEl.setAttribute(
    "transform",
    `translate(${svgNumber(THREE.MathUtils.clamp(input.yaw * 32, -44, 44))} ${svgNumber(
      THREE.MathUtils.clamp(-flight.alpha * 2.2, -44, 34),
    )})`,
  );

  renderPitchLadder(cameraPitchDegrees, cameraHorizonRollDegrees);
  renderVerticalTape(speedTicksEl, flight.speed, SPEED_TAPE_PARAMS);
  renderVerticalTape(altitudeTicksEl, altitude, ALTITUDE_TAPE_PARAMS);
  renderHeadingTape(headingDegrees);
  drawMinimap();
}

function calcCameraPitchDegrees() {
  cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(cameraForward.y, -0.999, 0.999)),
  );
}

function calcCameraHorizonRollDegrees() {
  cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  horizonRight.crossVectors(cameraForward, worldYawAxis);

  if (horizonRight.lengthSq() < 0.000001) {
    return 0;
  }

  horizonRight.normalize();

  let screenX = horizonRight.dot(cameraRight);
  let screenY = -horizonRight.dot(cameraUp);

  if (screenX < 0) {
    screenX = -screenX;
    screenY = -screenY;
  }

  return THREE.MathUtils.radToDeg(Math.atan2(screenY, screenX));
}

function pitchAngleToHudY(angleDegrees: number, cameraPitchDegrees: number) {
  const deltaRadians = THREE.MathUtils.degToRad(angleDegrees - cameraPitchDegrees);
  const focalScale = HUD_VIEWBOX_HALF_HEIGHT / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  return -Math.tan(deltaRadians) * focalScale;
}

function renderPitchLadder(cameraPitchDegrees: number, horizonRollDegrees: number) {
  const centerAngle = Math.round(cameraPitchDegrees / 5) * 5;
  const startAngle = centerAngle - 45;
  const endAngle = centerAngle + 45;
  let markup = `<g transform="rotate(${svgNumber(horizonRollDegrees)})">`;

  for (let angle = startAngle; angle <= endAngle; angle += 5) {
    if (Math.abs(angle) > 85) {
      continue;
    }

    const y = pitchAngleToHudY(angle, cameraPitchDegrees);

    if (Math.abs(y) > 180) {
      continue;
    }

    const isZero = angle === 0;
    const isMajor = angle % 10 === 0;
    const width = isZero ? 176 : isMajor ? 126 : 82;
    const gap = isZero ? 26 : 36;
    const className = isZero
      ? "hud-ladder-line hud-ladder-line--zero"
      : angle > 0
        ? "hud-ladder-line hud-ladder-line--climb"
        : "hud-ladder-line hud-ladder-line--dive";

    if (angle < 0) {
      const segment = (width - gap) / 3;
      const firstEnd = -gap - segment * 2.08;
      const secondStart = -gap - segment * 1.4;
      const secondEnd = -gap - segment * 0.64;

      markup += lineSvg(-width, y, firstEnd, y, className);
      markup += lineSvg(secondStart, y, secondEnd, y, className);
      markup += lineSvg(-gap - segment * 0.36, y, -gap, y, className);
      markup += lineSvg(width, y, -firstEnd, y, className);
      markup += lineSvg(-secondStart, y, -secondEnd, y, className);
      markup += lineSvg(gap + segment * 0.36, y, gap, y, className);
      markup += lineSvg(-width, y, -width, y + 9, className);
      markup += lineSvg(width, y, width, y + 9, className);
    } else {
      markup += lineSvg(-width, y, -gap, y, className);
      markup += lineSvg(gap, y, width, y, className);

      if (!isZero) {
        markup += lineSvg(-width, y, -width, y - 9, className);
        markup += lineSvg(width, y, width, y - 9, className);
      }
    }

    if (!isZero && isMajor) {
      const label = Math.abs(angle).toString();
      markup += `<text class="hud-ladder-label hud-ladder-label--left" x="${svgNumber(
        -width - 15,
      )}" y="${svgNumber(y + 5)}">${label}</text>`;
      markup += `<text class="hud-ladder-label hud-ladder-label--right" x="${svgNumber(
        width + 15,
      )}" y="${svgNumber(y + 5)}">${label}</text>`;
    }
  }

  markup += "</g>";
  pitchLadderEl.innerHTML = markup;
}

function renderVerticalTape(
  ticksEl: SVGGElement,
  currentValue: number,
  params: VerticalTapeParams,
) {
  const visibleUnits = 170 / params.pixelsPerUnit;
  const firstValue =
    Math.floor((currentValue - visibleUnits) / params.tickStep) * params.tickStep;
  const lastValue = currentValue + visibleUnits;
  const tickDir = params.side === "left" ? 1 : -1;
  const labelX = params.side === "left" ? -10 : 10;
  const labelAnchor = params.side === "left" ? "end" : "start";
  let markup = "";

  for (let value = firstValue; value <= lastValue; value += params.tickStep) {
    if (value < params.minValue) {
      continue;
    }

    const y = (currentValue - value) * params.pixelsPerUnit;

    if (Math.abs(y) > 148) {
      continue;
    }

    const isMajor = isMultiple(value, params.labelStep);
    const tickLength = isMajor ? 36 : 20;
    markup += lineSvg(0, y, tickDir * tickLength, y, "hud-tape-tick");

    if (isMajor && Math.abs(y) > 30) {
      markup += `<text class="hud-tape-label" x="${labelX}" y="${svgNumber(
        y + 5,
      )}" text-anchor="${labelAnchor}">${params.formatLabel(value)}</text>`;
    }
  }

  ticksEl.innerHTML = markup;
}

function renderHeadingTape(headingDegrees: number) {
  const tickStep = 5;
  const visibleDegrees = 36;
  const firstTick = Math.floor((headingDegrees - visibleDegrees) / tickStep) * tickStep;
  const lastTick = headingDegrees + visibleDegrees;
  let markup = "";

  for (let tick = firstTick; tick <= lastTick; tick += tickStep) {
    const value = wrapDegrees(tick);
    const delta = signedDegreesDelta(value, headingDegrees);
    const x = delta * HUD_HEADING_PIXELS_PER_DEGREE;

    if (Math.abs(x) > 210) {
      continue;
    }

    const isMajor = isMultiple(value, 10);
    const tickLength = isMajor ? 21 : 12;
    markup += lineSvg(x, -26, x, -26 + tickLength, "hud-heading-tick");

    if (isMajor && Math.abs(x) > 34) {
      markup += `<text class="hud-heading-label" x="${svgNumber(x)}" y="17">${formatHeadingTick(
        value,
      )}</text>`;
    }
  }

  headingTicksEl.innerHTML = markup;
}

function lineSvg(x1: number, y1: number, x2: number, y2: number, className: string) {
  return `<line class="${className}" x1="${svgNumber(x1)}" y1="${svgNumber(
    y1,
  )}" x2="${svgNumber(x2)}" y2="${svgNumber(y2)}" />`;
}

function formatHeadingTick(value: number) {
  const heading = Math.round(wrapDegrees(value));

  if (heading === 0 || heading === 360) {
    return "N";
  }

  if (heading === 90) {
    return "E";
  }

  if (heading === 180) {
    return "S";
  }

  if (heading === 270) {
    return "W";
  }

  return Math.round(heading / 10).toString().padStart(2, "0");
}

function formatBank(degrees: number) {
  const rounded = Math.round(Math.abs(degrees));

  if (rounded < 1) {
    return "00 LVL";
  }

  return `${rounded.toString().padStart(2, "0")} ${degrees < 0 ? "L" : "R"}`;
}

function wrapDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function signedDegreesDelta(value: number, center: number) {
  return ((value - center + 540) % 360) - 180;
}

function isMultiple(value: number, step: number) {
  return Math.abs(value / step - Math.round(value / step)) < 0.001;
}

function svgNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "0";
}

function drawMinimapTerrain(centerX: number, centerZ: number) {
  const image = minimapTerrainCtx.createImageData(MINIMAP_TEXTURE_SIZE, MINIMAP_TEXTURE_SIZE);

  for (let py = 0; py < MINIMAP_TEXTURE_SIZE; py += 1) {
    for (let px = 0; px < MINIMAP_TEXTURE_SIZE; px += 1) {
      const worldX = centerX + (px / (MINIMAP_TEXTURE_SIZE - 1) - 0.5) * MINIMAP_WORLD_SPAN;
      const worldZ = centerZ + (0.5 - py / (MINIMAP_TEXTURE_SIZE - 1)) * MINIMAP_WORLD_SPAN;
      const color = minimapTerrainColor(heightAt(worldX, worldZ));
      const index = (py * MINIMAP_TEXTURE_SIZE + px) * 4;
      image.data[index] = color[0];
      image.data[index + 1] = color[1];
      image.data[index + 2] = color[2];
      image.data[index + 3] = 255;
    }
  }

  minimapTerrainCtx.putImageData(image, 0, 0);
}

function drawMinimap() {
  const size = minimapCanvas.width;
  const padding = 7;
  const mapSize = size - padding * 2;
  const center = size * 0.5;

  minimapCtx.clearRect(0, 0, size, size);
  drawMinimapTerrain(flight.position.x, flight.position.z);
  minimapCtx.drawImage(minimapTerrainCanvas, padding, padding, mapSize, mapSize);
  minimapCtx.fillStyle = "rgba(5, 12, 18, 0.18)";
  minimapCtx.fillRect(padding, padding, mapSize, mapSize);

  minimapCtx.strokeStyle = "rgba(125, 229, 255, 0.22)";
  minimapCtx.lineWidth = 1;
  minimapCtx.beginPath();
  minimapCtx.moveTo(size * 0.5, padding);
  minimapCtx.lineTo(size * 0.5, size - padding);
  minimapCtx.moveTo(padding, size * 0.5);
  minimapCtx.lineTo(size - padding, size * 0.5);
  minimapCtx.stroke();

  drawMinimapLodFootprint(padding, mapSize);
  drawMinimapWrapBoundaries(padding, mapSize);

  minimapCtx.strokeStyle = "rgba(255, 231, 157, 0.9)";
  minimapCtx.lineWidth = 2;
  minimapCtx.strokeRect(padding + 1, padding + 1, mapSize - 2, mapSize - 2);

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  const heading = Math.atan2(forward.x, forward.z);
  drawMinimapAircraft(center, center, heading, 1);
}

function drawMinimapLodFootprint(padding: number, mapSize: number) {
  const sharpSpan = (TERRAIN_LEVELS[1].outer / MINIMAP_WORLD_SPAN) * mapSize;
  const midSpan = (TERRAIN_LEVELS[2].outer / MINIMAP_WORLD_SPAN) * mapSize;
  const center = padding + mapSize * 0.5;

  minimapCtx.strokeStyle = "rgba(125, 229, 255, 0.2)";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(center - midSpan * 0.5, center - midSpan * 0.5, midSpan, midSpan);
  minimapCtx.strokeStyle = "rgba(125, 229, 255, 0.4)";
  minimapCtx.strokeRect(center - sharpSpan * 0.5, center - sharpSpan * 0.5, sharpSpan, sharpSpan);
}

function drawMinimapWrapBoundaries(padding: number, mapSize: number) {
  const halfSpan = MINIMAP_WORLD_SPAN * 0.5;

  minimapCtx.save();
  minimapCtx.strokeStyle = "rgba(255, 231, 157, 0.75)";
  minimapCtx.lineWidth = 2;
  minimapCtx.setLineDash([5, 4]);

  for (const boundary of [-WORLD_WRAP_RADIUS, WORLD_WRAP_RADIUS]) {
    const dx = boundary - flight.position.x;
    if (Math.abs(dx) <= halfSpan) {
      const x = padding + (dx / MINIMAP_WORLD_SPAN + 0.5) * mapSize;
      minimapCtx.beginPath();
      minimapCtx.moveTo(x, padding);
      minimapCtx.lineTo(x, padding + mapSize);
      minimapCtx.stroke();
    }

    const dz = boundary - flight.position.z;
    if (Math.abs(dz) <= halfSpan) {
      const y = padding + (0.5 - dz / MINIMAP_WORLD_SPAN) * mapSize;
      minimapCtx.beginPath();
      minimapCtx.moveTo(padding, y);
      minimapCtx.lineTo(padding + mapSize, y);
      minimapCtx.stroke();
    }
  }

  minimapCtx.restore();
}

function minimapTerrainColor(height: number) {
  if (height < SEA_LEVEL) {
    return [25, 88, 112];
  }

  if (height < 28) {
    return [72, 117, 84];
  }

  if (height < 170) {
    return [116, 139, 87];
  }

  if (height < 330) {
    return [143, 132, 105];
  }

  return [214, 208, 188];
}

function drawMinimapAircraft(x: number, y: number, heading: number, alpha: number) {
  minimapCtx.save();
  minimapCtx.translate(x, y);
  minimapCtx.rotate(heading);
  minimapCtx.globalAlpha = alpha;
  minimapCtx.fillStyle = "#ffe79d";
  minimapCtx.strokeStyle = "#07121b";
  minimapCtx.lineWidth = 1.5;
  minimapCtx.beginPath();
  minimapCtx.moveTo(0, -8);
  minimapCtx.lineTo(6, 7);
  minimapCtx.lineTo(0, 4);
  minimapCtx.lineTo(-6, 7);
  minimapCtx.closePath();
  minimapCtx.fill();
  minimapCtx.stroke();
  minimapCtx.restore();
}

type F14Materials = ReturnType<typeof createF14Materials>;

function createF14() {
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

function createTerrainSystem() {
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

function heightAt(x: number, z: number) {
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
    const radius = 62000;
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

function addPolygon(positions: number[], points: THREE.Vector3[]) {
  for (let i = 1; i < points.length - 1; i += 1) {
    addTriangle(positions, points[0], points[i], points[i + 1]);
  }
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

function dampAngle(current: number, target: number, lambda: number, delta: number) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-lambda * delta));
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

function mustElement<T extends Element = HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing ${selector} element`);
  }

  return element;
}
