import * as THREE from "three";
import { createF14, F14_WING_SWEEP_DELTA } from "./aircraft";
import { createHud, type HudFrame } from "./hud";
import {
  createHorizonMarkers,
  createTerrainSystem,
  heightAt,
  SEA_LEVEL,
  WORLD_WRAP_RADIUS,
  WORLD_WRAP_SIZE,
} from "./terrain";
import "./style.css";

// main.ts is the runtime coordinator. It owns the simulation loop and passes state to focused
// rendering modules; aircraft construction, terrain generation, and HUD drawing live elsewhere.
const canvas = document.querySelector<HTMLCanvasElement>("#sim");

if (!canvas) {
  throw new Error("Missing #sim canvas");
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  // The terrain spans a very large depth range, so a logarithmic buffer reduces distant z-fighting.
  logarithmicDepthBuffer: true,
  powerPreference: "high-performance",
});

// Cap render resolution below extreme display pixel ratios. This preserves most of the visual
// benefit of a Retina display without multiplying the fragment-shader workload unnecessarily.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x83c9df);
// Exponential fog hides the finite terrain extent and supplies atmospheric depth cues.
scene.fog = new THREE.FogExp2(0x9ec8d1, 0.000046);

// World units are intentionally large. The far plane must include the horizon terrain, while the
// near plane stays far enough from the camera to retain useful depth-buffer precision.
const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  2,
  108000,
);

const CHASE_CAMERA_ROLL_RESPONSE = 3.2;

// Hemisphere and ambient lights keep the faceted underside readable. The directional light is the
// sun and is repositioned around the aircraft so its finite shadow camera follows the action.
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

type FlightState = {
  // Position is in world units. Attitude is authoritative in quaternion form; Euler angles are
  // synchronized afterward because the camera, HUD, and control animation need readable angles.
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

type Inputs = {
  // All control axes are normalized to approximately -1..1 before the flight model consumes them.
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  pointerPitch: number;
  pointerRoll: number;
};

declare global {
  interface Window {
    // Development-only inspection hook used by browser checks and screenshot tooling.
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
  // Start already airborne and facing into the procedural world so the demo is immediately useful.
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

const clock = new THREE.Clock();
let running = true;
let animationFrameId = 0;
let cameraRoll = 0;

// Scratch vectors and quaternions are reused every frame. Keeping them here avoids short-lived
// allocations and garbage-collection pauses in the animation loop.
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
const chaseAnchorPosition = flight.position.clone();
const chaseTranslation = new THREE.Vector3();
const wrapOffset = new THREE.Vector3();

type ViewMode = "chase" | "orbit";

// Chase mode flies the simulation. Orbit mode freezes flight motion and lets the pointer inspect
// the aircraft from a spherical camera rig centered on targetPos.
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

const hud = createHud();

// The HUD keeps this stable object rather than allocating a new frame description on every tick.
// Its object references stay valid; only the scalar fields below need refreshing before update().
const hudFrame: HudFrame = {
  camera,
  flight,
  controls: input,
  terrainBands: 0,
  viewMode: view.mode,
};

const aircraft = createF14();
scene.add(aircraft.root);

const terrain = createTerrainSystem();
scene.add(terrain.group);

if (import.meta.env.DEV) {
  // Production builds omit this hook entirely. In development it allows deterministic pauses
  // without teaching the simulation loop about any particular test runner.
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

// Horizon markers and the sea plane follow the aircraft laterally. They are visual references, not
// physical world objects, so keeping them nearby avoids exhausting floating-point precision.
const horizonGrid = createHorizonMarkers();
scene.add(horizonGrid);

const keys = new Set<string>();
const pointer = {
  active: false,
  id: -1,
  startX: 0,
  startY: 0,
};

// Keyboard state is stored as a set so opposite controls can cancel cleanly and multiple keys can
// remain held between animation frames. V is handled immediately because it toggles a mode.
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

  // The same canvas gesture has two meanings: orbit the inspection camera, or command pitch/roll
  // while flying. Keeping the branches here prevents camera input from leaking into flight input.
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

    // Wheel input zooms the inspection camera in orbit mode and controls throttle in chase mode.
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

  // Clamp long frame gaps so a paused tab cannot produce a huge physics step on its first frame.
  const delta = Math.min(clock.getDelta(), 0.045);
  updateInput(delta);

  // Orbit mode deliberately pauses the aircraft while camera, HUD, and renderer continue updating.
  if (view.mode === "chase") {
    updateFlight(delta);
  }

  wrapWorldIfNeeded();
  updateAircraft(delta);
  terrain.update(flight.position);
  updateWorldAnchors();
  updateCamera(delta, view.mode);

  // Terrain and view mode are the only HUD frame fields whose values are not stable object refs.
  hudFrame.terrainBands = terrain.activeBands;
  hudFrame.viewMode = view.mode;
  hud.update(hudFrame);
  renderer.render(scene, camera);
  animationFrameId = requestAnimationFrame(tick);
}

function updateInput(delta: number) {
  // Keyboard pairs become signed axes. Pointer pitch/roll are blended into the same normalized
  // controls, and damping makes device changes feel continuous instead of producing hard steps.
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
  // Throttle approaches a target forward speed rather than applying force through a full engine
  // model. A small dive/climb term gives the lightweight model an intuitive exchange of altitude
  // and speed without attempting to be an aerodynamic simulator.
  flight.throttle = THREE.MathUtils.clamp(
    flight.throttle + input.throttle * delta * 0.42,
    0,
    1,
  );

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);

  const targetSpeed = THREE.MathUtils.lerp(190, 760, flight.throttle);
  const diveAssist = THREE.MathUtils.clamp(-forward.y, -0.35, 0.35) * 95;
  flight.speed = damp(flight.speed, targetSpeed + diveAssist, 0.82, delta);

  // Control authority grows with airspeed. Angular velocity is damped toward the pilot command so
  // the aircraft has inertia and does not snap directly to a requested attitude.
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

  // Pitch, yaw, and roll are body-axis rotations. Bank-to-turn is then applied around world up,
  // allowing a rolled aircraft to curve naturally without requiring a separate rudder command.
  right.set(1, 0, 0).applyQuaternion(flight.quaternion);
  const bankTurn = -right.y * 0.52 * authority;
  applyWorldRotation(worldYawAxis, -bankTurn * delta);
  syncFlightAnglesFromQuaternion();

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  flight.position.addScaledVector(forward, flight.speed * delta);

  // Maintain a simple clearance envelope above procedural terrain. This is a forgiving demo guard,
  // not collision geometry; it prevents the camera and aircraft from disappearing underground.
  const ground = heightAt(flight.position.x, flight.position.z) + 72;

  if (flight.position.y < ground) {
    flight.position.y = ground;
    flight.speed = Math.max(flight.speed * 0.965, 190);
    flight.angularVelocity.x = Math.max(flight.angularVelocity.x, 0);
  }

  // G and AOA are presentation-oriented estimates derived from control input, angular rate, and
  // attitude. They drive convincing HUD feedback without feeding forces back into the flight model.
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
  // The terrain function is periodic. Teleporting all camera-relative state by one period lets the
  // aircraft fly indefinitely while positions remain near the origin and numerically well behaved.
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
  chaseAnchorPosition.add(wrapOffset);
  view.targetPos.add(wrapOffset);
}

function updateWorldAnchors() {
  // These large visual planes only need to appear infinite; following x/z is cheaper than making
  // genuinely enormous geometry and keeps their vertices close to the floating-point origin.
  sea.position.x = flight.position.x;
  sea.position.z = flight.position.z;
  horizonGrid.position.x = flight.position.x;
  horizonGrid.position.z = flight.position.z;
}

function updateAircraft(delta: number) {
  // FlightState is authoritative. The procedural model is a visual follower whose articulated
  // parts are animated from speed, throttle, and current control input.
  aircraft.root.position.copy(flight.position);
  aircraft.root.quaternion.copy(flight.quaternion);

  // Wing sweep increases continuously across the useful speed range.
  const sweep = THREE.MathUtils.mapLinear(
    THREE.MathUtils.clamp(flight.speed, 250, 700),
    250,
    700,
    0,
    F14_WING_SWEEP_DELTA,
  );
  aircraft.leftWing.rotation.y = sweep;
  aircraft.rightWing.rotation.y = -sweep;

  // Exhaust nozzles open with throttle; burner meshes appear only near maximum power and their
  // length is damped to avoid a distracting single-frame pop.
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

  // Differential stabilator movement combines pitch and roll commands.
  const stabilatorPitch = input.pitch * 0.19;
  const stabilatorRoll = input.roll * 0.045;
  aircraft.stabilizerLeft.rotation.x = 0.025 + stabilatorPitch + stabilatorRoll;
  aircraft.stabilizerRight.rotation.x = 0.025 + stabilatorPitch - stabilatorRoll;
}

function updateCamera(delta: number, mode: ViewMode) {
  if (mode === "orbit") {
    // Orbit uses spherical coordinates around a frozen target. Camera interpolation makes pointer
    // motion smooth, while resetting roll keeps the inspection view level with the world.
    chaseAnchorPosition.copy(flight.position);
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

  // Inherit the aircraft's world translation before smoothing the relative chase offset. Without
  // this, camera damping turns forward speed into an unintended, very long follow distance.
  chaseTranslation.copy(flight.position).sub(chaseAnchorPosition);
  camera.position.add(chaseTranslation);
  chaseAnchorPosition.copy(flight.position);

  // Pull the chase camera back as speed rises. Portrait-like aspect ratios receive additional
  // distance and look-ahead so the aircraft remains framed without changing its world scale.
  const speedRatio = THREE.MathUtils.clamp(flight.speed / 760, 0, 1);
  const chaseFramingScale = THREE.MathUtils.clamp(1 / camera.aspect, 1, 2.4);
  const chaseDistance = THREE.MathUtils.lerp(50, 74, speedRatio) * chaseFramingScale;
  const cameraHeight = THREE.MathUtils.lerp(13, 21, speedRatio) * chaseFramingScale;

  forward.set(0, 0, -1).applyQuaternion(flight.quaternion);

  cameraDesired
    .copy(flight.position)
    .addScaledVector(forward, -chaseDistance)
    .addScaledVector(worldYawAxis, cameraHeight);
  camera.position.lerp(cameraDesired, 1 - Math.exp(-delta * 4.2));

  // Looking ahead of the aircraft reveals upcoming terrain and makes the camera feel less like it
  // is locked directly to the model origin.
  cameraTarget
    .copy(flight.position)
    .addScaledVector(forward, 104 * chaseFramingScale)
    .addScaledVector(worldYawAxis, 3 * chaseFramingScale);
  camera.up.copy(worldYawAxis);
  camera.lookAt(cameraTarget);
  cameraRoll = dampAngle(cameraRoll, -flight.roll, CHASE_CAMERA_ROLL_RESPONSE, delta);
  camera.rotateZ(cameraRoll);

  sun.target.position.copy(flight.position);
  sun.position.copy(flight.position).add(new THREE.Vector3(-580, 940, 360));
}

function toggleViewMode() {
  if (view.mode === "chase") {
    // Seed orbit from the current aircraft state so switching modes does not jump to the origin.
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
}

function damp(current: number, target: number, lambda: number, delta: number) {
  // Exponential damping is frame-rate independent: lambda describes response speed per second.
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * delta));
}

function dampAngle(current: number, target: number, lambda: number, delta: number) {
  // atan2 chooses the shortest path across the -pi/pi seam before applying the same damping rule.
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-lambda * delta));
}

function applyLocalRotation(axis: THREE.Vector3, radians: number) {
  if (Math.abs(radians) < 0.000001) {
    return;
  }

  // Post-multiplication applies the increment in aircraft-local coordinates.
  localRotation.setFromAxisAngle(axis, radians);
  flight.quaternion.multiply(localRotation).normalize();
}

function applyWorldRotation(axis: THREE.Vector3, radians: number) {
  if (Math.abs(radians) < 0.000001) {
    return;
  }

  // Pre-multiplication applies the increment in world coordinates.
  localRotation.setFromAxisAngle(axis, radians);
  flight.quaternion.premultiply(localRotation).normalize();
}

function syncQuaternionFromFlightAngles() {
  // The initial Euler angles are convenient to author, but the quaternion becomes authoritative
  // immediately so runtime rotations avoid Euler-order accumulation and gimbal-lock artifacts.
  flight.quaternion.setFromEuler(
    attitudeEuler.set(flight.pitch, flight.yaw, -flight.roll, "YXZ"),
  );
}

function syncFlightAnglesFromQuaternion() {
  // Readable angles are derived after quaternion updates for control animation, camera roll, and HUD.
  attitudeEuler.setFromQuaternion(flight.quaternion, "YXZ");
  flight.pitch = attitudeEuler.x;
  flight.yaw = attitudeEuler.y;
  flight.roll = -attitudeEuler.z;
}
