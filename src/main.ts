import * as THREE from "three";
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
  aircraft.leftNozzle.scale.setScalar(nozzleScale);
  aircraft.rightNozzle.scale.setScalar(nozzleScale);
  aircraft.afterburnerLeft.visible = flight.throttle > 0.82;
  aircraft.afterburnerRight.visible = aircraft.afterburnerLeft.visible;
  aircraft.afterburnerLeft.scale.y = damp(
    aircraft.afterburnerLeft.scale.y,
    0.75 + flight.throttle * 1.4,
    12,
    delta,
  );
  aircraft.afterburnerRight.scale.y = aircraft.afterburnerLeft.scale.y;
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

function createF14() {
  const root = new THREE.Group();
  root.name = "Measured low-poly F-14A Tomcat";
  root.scale.setScalar(4.5);

  const paint = new THREE.MeshStandardMaterial({
    color: 0xb8bdc0,
    roughness: 0.78,
    metalness: 0.15,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const darkPaint = new THREE.MeshStandardMaterial({
    color: 0x4a525d,
    roughness: 0.82,
    metalness: 0.18,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const radomePaint = new THREE.MeshStandardMaterial({
    color: 0x858b8e,
    roughness: 0.84,
    metalness: 0.12,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x19344d,
    roughness: 0.34,
    metalness: 0.22,
    emissive: 0x06121d,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const intakeMat = new THREE.MeshStandardMaterial({
    color: 0x151b24,
    roughness: 0.9,
    metalness: 0.08,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xff9a2f,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  const noseTipFt = -F14_DIMENSIONS.lengthFt / 2;
  const tailFt = F14_DIMENSIONS.lengthFt / 2;

  const radome = createLoftedMesh(
    [
      { z: noseTipFt, halfWidth: 0.08, top: 0.04, upper: 0.02, side: -0.02, lower: -0.07, bottom: -0.1 },
      { z: -28.2, halfWidth: 0.82, top: 0.62, upper: 0.38, side: -0.02, lower: -0.46, bottom: -0.62 },
      { z: -25.1, halfWidth: 1.68, top: 1.55, upper: 1.02, side: 0.02, lower: -0.6, bottom: -0.9 },
    ],
    radomePaint,
  );
  root.add(radome);

  const fuselage = createLoftedMesh(
    [
      { z: -25.1, halfWidth: 1.68, top: 1.55, upper: 1.02, side: 0.02, lower: -0.6, bottom: -0.9 },
      { z: -21.5, halfWidth: 2.35, top: 2.32, upper: 1.5, side: 0, lower: -0.72, bottom: -1.04 },
      { z: -16.2, halfWidth: 2.95, top: 2.92, upper: 1.86, side: -0.02, lower: -0.84, bottom: -1.15 },
      { z: -9.4, halfWidth: 3.35, top: 2.62, upper: 1.56, side: -0.12, lower: -0.9, bottom: -1.2 },
      { z: -2.4, halfWidth: 3.15, top: 2.34, upper: 1.34, side: -0.18, lower: -0.9, bottom: -1.18 },
      { z: 8.7, halfWidth: 2.92, top: 2.1, upper: 1.18, side: -0.2, lower: -0.84, bottom: -1.08 },
      { z: 17.8, halfWidth: 2.35, top: 1.92, upper: 0.96, side: -0.2, lower: -0.72, bottom: -0.92 },
      { z: 25.5, halfWidth: 1.45, top: 1.3, upper: 0.58, side: -0.15, lower: -0.42, bottom: -0.58 },
      { z: tailFt - 0.85, halfWidth: 0.72, top: 0.75, upper: 0.35, side: -0.08, lower: -0.28, bottom: -0.38 },
    ],
    paint,
  );
  root.add(fuselage);

  const canopyBase = createLoftedMesh(
    [
      { z: -24.7, halfWidth: 1.28, top: 2.22, upper: 2.06, side: 1.84, lower: 1.72, bottom: 1.66 },
      { z: -20.5, halfWidth: 1.76, top: 2.82, upper: 2.58, side: 2.32, lower: 2.16, bottom: 2.08 },
      { z: -14.1, halfWidth: 1.92, top: 2.98, upper: 2.72, side: 2.48, lower: 2.3, bottom: 2.2 },
      { z: -11.3, halfWidth: 1.28, top: 2.74, upper: 2.52, side: 2.28, lower: 2.12, bottom: 2.04 },
    ],
    darkPaint,
  );
  root.add(canopyBase);

  const canopy = createCanopy(canopyMat);
  root.add(canopy);

  const dorsalSpine = createLoftedMesh(
    [
      { z: -12.2, halfWidth: 1.1, top: 2.72, upper: 2.5, side: 2.25, lower: 2.08, bottom: 1.98 },
      { z: 0.5, halfWidth: 1.46, top: 2.58, upper: 2.32, side: 2.02, lower: 1.88, bottom: 1.78 },
      { z: 14.6, halfWidth: 1.22, top: 2.32, upper: 2.04, side: 1.76, lower: 1.62, bottom: 1.54 },
      { z: 22.4, halfWidth: 0.66, top: 1.75, upper: 1.52, side: 1.3, lower: 1.16, bottom: 1.08 },
    ],
    paint,
  );
  root.add(dorsalSpine);

  root.add(createChinPod(intakeMat), createPitotProbe(darkPaint));
  root.add(createShoulderFairing(-1, paint), createShoulderFairing(1, paint));

  const leftWing = createWing(-1, paint);
  const rightWing = createWing(1, paint);
  root.add(leftWing, rightWing);

  root.add(createWingGlove(-1, paint), createWingGlove(1, paint));

  const leftIntake = createIntake(-1, intakeMat, paint);
  const rightIntake = createIntake(1, intakeMat, paint);
  root.add(leftIntake, rightIntake);

  const nacelles = [-1, 1].map((side) => {
    const nacelle = createEngineNacelle(side as -1 | 1, darkPaint);
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

  root.add(createVentralFin(-1, darkPaint), createVentralFin(1, darkPaint));

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

function ft(value: number) {
  return value * F14_FT_TO_UNIT;
}

function vft(x: number, y: number, z: number) {
  return new THREE.Vector3(ft(x), ft(y), ft(z));
}

function createLoftedMesh(stations: LoftStation[], material: THREE.Material) {
  const mesh = new THREE.Mesh(loftedSectionGeometry(stations), material);
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

function createCanopy(glassMaterial: THREE.Material) {
  const group = new THREE.Group();
  const glass = createLoftedMesh(
    [
      { z: -24.1, halfWidth: 0.88, top: 2.78, upper: 2.58, side: 2.28, lower: 2.16, bottom: 2.08 },
      { z: -21.5, halfWidth: 1.52, top: 4.55, upper: 3.58, side: 2.58, lower: 2.42, bottom: 2.34 },
      { z: -18.45, halfWidth: 1.68, top: 4.86, upper: 3.78, side: 2.66, lower: 2.46, bottom: 2.36 },
      { z: -15.2, halfWidth: 1.5, top: 4.36, upper: 3.38, side: 2.58, lower: 2.38, bottom: 2.28 },
      { z: -12.9, halfWidth: 0.82, top: 3.08, upper: 2.82, side: 2.38, lower: 2.2, bottom: 2.1 },
    ],
    glassMaterial,
  );
  group.add(glass);
  return group;
}

function createWing(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  const pivotXFt = F14_DIMENSIONS.wingPivotButtlineFt;
  const movableSpanFt = F14_DIMENSIONS.maxSpanFt / 2 - pivotXFt;
  const sweepOffsetFt =
    Math.tan(THREE.MathUtils.degToRad(F14_DIMENSIONS.unsweptLeadingEdgeDeg)) *
    movableSpanFt;

  group.position.set(side * ft(pivotXFt), ft(0.24), ft(-4.1));

  const wing = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: 0, z: -1.15 },
        { x: side * movableSpanFt, z: -1.15 + sweepOffsetFt },
        { x: side * (movableSpanFt - 0.55), z: 13.95 },
        { x: side * 1.25, z: 10.05 },
        { x: 0, z: 6.25 },
      ],
      0.52,
      -1.83,
    ),
    material,
  );
  group.add(wing);

  return group;
}

function createWingGlove(side: -1 | 1, material: THREE.Material) {
  const glove = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: side * 3.65, z: -10.6 },
        { x: side * F14_DIMENSIONS.wingPivotButtlineFt, z: -5.7 },
        { x: side * 8.45, z: 7.2 },
        { x: side * 3.35, z: 5.35 },
      ],
      0.46,
      -0.6,
    ),
    material,
  );
  glove.position.y = ft(0.2);
  return glove;
}

function createShoulderFairing(side: -1 | 1, material: THREE.Material) {
  const mesh = new THREE.Mesh(
    shoulderFairingGeometry(
      side,
      [
        { z: -13.4, innerX: 2.86, outerX: 3.82, innerY: 1.78, outerY: 0.98 },
        { z: -8.4, innerX: 3.28, outerX: 3.62, innerY: 1.46, outerY: 0.92 },
        { z: -1.5, innerX: 3.08, outerX: 3.54, innerY: 1.22, outerY: 0.78 },
        { z: 8.8, innerX: 2.84, outerX: 3.62, innerY: 1.0, outerY: 0.66 },
        { z: 18.4, innerX: 2.34, outerX: 3.78, innerY: 0.78, outerY: 0.5 },
        { z: 25.3, innerX: 1.48, outerX: 3.52, innerY: 0.44, outerY: 0.34 },
      ],
      0.2,
    ),
    material,
  );
  mesh.castShadow = true;
  return mesh;
}

function createIntake(
  side: -1 | 1,
  intakeMaterial: THREE.Material,
  bodyMaterial: THREE.Material,
) {
  const group = new THREE.Group();
  group.position.set(side * ft(5.85), ft(-0.34), ft(-12.15));

  const scoop = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(6.2),
      frontWidth: ft(4.3),
      backWidth: ft(3.75),
      frontHeight: ft(2.82),
      backHeight: ft(2.35),
    }),
    bodyMaterial,
  );
  scoop.rotation.z = side * -0.035;
  scoop.castShadow = true;
  group.add(scoop);

  const mouth = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(0.44),
      frontWidth: ft(3.62),
      backWidth: ft(3.62),
      frontHeight: ft(2.22),
      backHeight: ft(2.22),
    }),
    intakeMaterial,
  );
  mouth.position.z = ft(-3.34);
  mouth.castShadow = true;
  group.add(mouth);

  const ramp = new THREE.Mesh(
    taperedBoxGeometry({
      length: ft(3.7),
      frontWidth: ft(3.36),
      backWidth: ft(3.05),
      frontHeight: ft(0.22),
      backHeight: ft(0.18),
    }),
    intakeMaterial,
  );
  ramp.position.set(0, ft(0.82), ft(-1.65));
  ramp.rotation.x = -0.08;
  group.add(ramp);

  return group;
}

function createEngineNacelle(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  const engineRadiusFt = F14_DIMENSIONS.engineDiameterFt / 2;
  group.position.x = side * ft(5.85);

  const pod = createLoftedMesh(
    [
      { z: -9.2, halfWidth: engineRadiusFt * 1.08, top: 0.92, upper: 0.48, side: -0.42, lower: -1.34, bottom: -1.72 },
      { z: -2.0, halfWidth: engineRadiusFt * 1.12, top: 0.82, upper: 0.34, side: -0.5, lower: -1.38, bottom: -1.78 },
      { z: 12.5, halfWidth: engineRadiusFt * 1.06, top: 0.72, upper: 0.28, side: -0.52, lower: -1.34, bottom: -1.7 },
      { z: 25.4, halfWidth: engineRadiusFt * 0.96, top: 0.56, upper: 0.16, side: -0.5, lower: -1.22, bottom: -1.52 },
      { z: 30.25, halfWidth: engineRadiusFt * 0.78, top: 0.42, upper: 0.08, side: -0.48, lower: -1.02, bottom: -1.26 },
    ],
    material,
  );
  group.add(pod);

  return group;
}

function createNozzle(side: -1 | 1) {
  const material = new THREE.MeshStandardMaterial({
    color: 0x20242b,
    roughness: 0.72,
    metalness: 0.34,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(1.55), ft(F14_DIMENSIONS.engineDiameterFt / 2), ft(2.0), 10, 1),
    material,
  );
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(side * ft(5.85), ft(-0.54), ft(30.72));
  nozzle.castShadow = true;
  return nozzle;
}

function createAfterburner(side: -1 | 1, material: THREE.Material) {
  const burner = new THREE.Mesh(new THREE.ConeGeometry(ft(1.05), ft(4.0), 10, 1), material);
  burner.rotation.x = Math.PI / 2;
  burner.position.set(side * ft(5.85), ft(-0.54), ft(32.65));
  burner.visible = false;
  return burner;
}

function createVerticalTail(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * ft(5.75), ft(1.0), ft(19.0));
  group.rotation.z = side * -0.16;

  const thickness = ft(0.44);
  const sx = thickness * 0.5;
  const positions: number[] = [];
  const left = [
    new THREE.Vector3(-sx, 0, ft(-3.25)),
    new THREE.Vector3(-sx, ft(0.26), ft(6.1)),
    new THREE.Vector3(-sx, ft(10.7), ft(4.7)),
    new THREE.Vector3(-sx, ft(12.2), ft(1.25)),
  ];
  const right = left.map((point) => point.clone().setX(sx));

  addPolygon(positions, left);
  addPolygon(positions, [...right].reverse());
  for (let i = 0; i < left.length; i += 1) {
    const next = (i + 1) % left.length;
    addQuad(positions, left[i], left[next], right[next], right[i]);
  }

  const tail = new THREE.Mesh(bufferGeometryFromPositions(positions), material);
  tail.castShadow = true;
  group.add(tail);
  return group;
}

function createStabilizer(side: -1 | 1, material: THREE.Material) {
  const group = new THREE.Group();
  group.position.set(side * ft(3.15), ft(-0.22), ft(25.4));
  group.rotation.y = side * -0.18;
  group.rotation.x = 0.04;

  const stabilizer = new THREE.Mesh(
    planformPrismGeometry(
      [
        { x: 0, z: -2.9 },
        { x: side * 10.2, z: -0.65 },
        { x: side * 10.8, z: 3.1 },
        { x: side * 0.42, z: 5.2 },
      ],
      0.42,
      0,
    ),
    material,
  );
  stabilizer.castShadow = true;
  group.add(stabilizer);
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

function createBellyOrdnance(
  bodyMaterial: THREE.Material,
  darkMaterial: THREE.Material,
) {
  const group = new THREE.Group();
  const railMaterial = darkMaterial;
  const missileMaterial = bodyMaterial;

  for (const x of [-1.22, 1.22]) {
    const rail = new THREE.Mesh(
      taperedBoxGeometry({
        length: ft(13.2),
        frontWidth: ft(0.34),
        backWidth: ft(0.34),
        frontHeight: ft(0.24),
        backHeight: ft(0.24),
      }),
      railMaterial,
    );
    rail.position.set(ft(x), ft(-1.72), ft(2.4));
    rail.castShadow = true;
    group.add(rail);

    const missile = new THREE.Mesh(
      new THREE.CylinderGeometry(ft(0.52), ft(0.52), ft(12.2), 8),
      missileMaterial,
    );
    missile.rotation.x = Math.PI / 2;
    missile.position.set(ft(x), ft(-2.08), ft(2.45));
    missile.castShadow = true;
    group.add(missile);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(ft(0.52), ft(1.35), 8), missileMaterial);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(ft(x), ft(-2.08), ft(-4.32));
    group.add(nose);
  }

  return group;
}

function createChinPod(material: THREE.Material) {
  const pod = new THREE.Mesh(
    new THREE.CylinderGeometry(ft(0.36), ft(0.46), ft(0.9), 6, 1),
    material,
  );
  pod.rotation.z = Math.PI / 2;
  pod.position.set(0, ft(-1.08), ft(-23.6));
  return pod;
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
