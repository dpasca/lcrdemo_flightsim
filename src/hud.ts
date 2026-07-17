import * as THREE from "three";
import {
  heightAt,
  MINIMAP_WORLD_SPAN,
  SEA_LEVEL,
  TERRAIN_LEVELS,
  WORLD_WRAP_RADIUS,
} from "./terrain";

// This module owns the presentation layer for the flight instruments. It reads one frame of
// simulation state at a time and updates the existing HTML, SVG, and canvas elements; it never
// feeds values back into the aircraft or camera simulation.
const MINIMAP_TEXTURE_SIZE = 128;
const HUD_VIEWBOX_HALF_HEIGHT = 300;
const HUD_HEADING_PIXELS_PER_DEGREE = 6;

export type HudViewMode = "chase" | "orbit";

// Flight and control data are kept separate so it remains clear which values describe the
// aircraft itself and which values are the pilot's current input commands.
export type HudFlightData = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  roll: number;
  throttle: number;
  speed: number;
  gForce: number;
  alpha: number;
};

export type HudControlData = {
  yaw: number;
  pointerPitch: number;
  pointerRoll: number;
};

export type HudFrame = {
  camera: THREE.PerspectiveCamera;
  flight: HudFlightData;
  controls: HudControlData;
  terrainBands: number;
  viewMode: HudViewMode;
};

export type HudController = {
  update: (frame: HudFrame) => void;
};

// Both vertical tapes use the same renderer. These parameters describe their units, scale, and
// which direction ticks should extend from the tape's inner edge.
type VerticalTapeParams = {
  tickStep: number;
  labelStep: number;
  pixelsPerUnit: number;
  side: "left" | "right";
  minValue: number;
  formatLabel: (value: number) => string;
};

type HudElements = {
  pitchLadder: SVGGElement;
  speedTicks: SVGGElement;
  altitudeTicks: SVGGElement;
  headingTicks: SVGGElement;
  bankPointer: SVGGElement;
  flightPathMarker: SVGGElement;
  speed: SVGTextElement;
  altitude: SVGTextElement;
  throttle: SVGTextElement;
  bank: SVGTextElement;
  heading: SVGTextElement;
  lod: SVGTextElement;
  gForce: SVGTextElement;
  alpha: SVGTextElement;
  throttleFill: HTMLElement;
  stickDot: HTMLElement;
  viewBadge: HTMLElement;
};

type HudRuntime = {
  elements: HudElements;
  minimapCanvas: HTMLCanvasElement;
  minimapContext: CanvasRenderingContext2D;
  minimapTerrainCanvas: HTMLCanvasElement;
  minimapTerrainContext: CanvasRenderingContext2D;
  forward: THREE.Vector3;
  cameraForward: THREE.Vector3;
  cameraRight: THREE.Vector3;
  cameraUp: THREE.Vector3;
  horizonRight: THREE.Vector3;
  worldUp: THREE.Vector3;
};

// The tape scales are visual choices rather than simulation units. Keeping them here makes it easy
// to adjust instrument density without touching the generic tape renderer below.
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

// Connect the static HUD markup in index.html to live simulation data. Resolving every required
// element once at startup avoids repeated DOM queries in the animation loop and fails early if the
// markup and TypeScript ever drift out of sync.
export function createHud(root: ParentNode = document): HudController {
  const minimapCanvas = mustElement<HTMLCanvasElement>(root, "#minimap");
  const minimapContext = minimapCanvas.getContext("2d");

  // Terrain is first rendered into a small fixed-resolution canvas, then enlarged into the framed
  // display. This bounds the expensive height-field sampling independently of the display size.
  const minimapTerrainCanvas = document.createElement("canvas");
  minimapTerrainCanvas.width = MINIMAP_TEXTURE_SIZE;
  minimapTerrainCanvas.height = MINIMAP_TEXTURE_SIZE;
  const minimapTerrainContext = minimapTerrainCanvas.getContext("2d");

  if (!minimapContext || !minimapTerrainContext) {
    throw new Error("Missing minimap canvas context");
  }

  const runtime: HudRuntime = {
    elements: {
      pitchLadder: mustElement<SVGGElement>(root, "#pitch-ladder"),
      speedTicks: mustElement<SVGGElement>(root, "#speed-ticks"),
      altitudeTicks: mustElement<SVGGElement>(root, "#altitude-ticks"),
      headingTicks: mustElement<SVGGElement>(root, "#heading-ticks"),
      bankPointer: mustElement<SVGGElement>(root, "#bank-pointer"),
      flightPathMarker: mustElement<SVGGElement>(root, "#flight-path-marker"),
      speed: mustElement<SVGTextElement>(root, "#speed"),
      altitude: mustElement<SVGTextElement>(root, "#altitude"),
      throttle: mustElement<SVGTextElement>(root, "#throttle"),
      bank: mustElement<SVGTextElement>(root, "#bank"),
      heading: mustElement<SVGTextElement>(root, "#heading"),
      lod: mustElement<SVGTextElement>(root, "#lod"),
      gForce: mustElement<SVGTextElement>(root, "#gforce"),
      alpha: mustElement<SVGTextElement>(root, "#alpha"),
      throttleFill: mustElement<HTMLElement>(root, "#throttle-fill"),
      stickDot: mustElement<HTMLElement>(root, "#stick-dot"),
      viewBadge: mustElement<HTMLElement>(root, "#view-badge"),
    },
    minimapCanvas,
    minimapContext,
    minimapTerrainCanvas,
    minimapTerrainContext,

    // These vectors are scratch storage reused by every frame. Reuse matters here because HUD
    // updates run continuously and short-lived Three.js objects would create garbage-collection
    // pressure that can show up as visible frame-time hitches.
    forward: new THREE.Vector3(),
    cameraForward: new THREE.Vector3(),
    cameraRight: new THREE.Vector3(),
    cameraUp: new THREE.Vector3(),
    horizonRight: new THREE.Vector3(),
    worldUp: new THREE.Vector3(0, 1, 0),
  };

  return {
    update: (frame) => updateHud(runtime, frame),
  };
}

function updateHud(runtime: HudRuntime, frame: HudFrame) {
  const { camera, controls, flight } = frame;
  const { elements } = runtime;

  // Altitude is displayed above the terrain directly below the aircraft, not above sea level. The
  // heading comes from the aircraft's world-space forward vector and is normalized to 000-359.
  const altitude = Math.max(0, flight.position.y - heightAt(flight.position.x, flight.position.z));
  runtime.forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  const headingDegrees = positiveDegrees(Math.atan2(-runtime.forward.x, runtime.forward.z));
  const rollDegrees = THREE.MathUtils.radToDeg(flight.roll);
  const cameraPitchDegrees = calcCameraPitchDegrees(runtime, camera);
  const cameraHorizonRollDegrees = calcCameraHorizonRollDegrees(runtime, camera);

  // The boxed values are the pilot's immediate readings; the moving tapes around them provide
  // nearby speed, altitude, and heading context without making the pilot read a dense instrument.
  elements.speed.textContent = Math.round(flight.speed).toString().padStart(3, "0");
  elements.altitude.textContent = Math.round(altitude).toString().padStart(5, "0");
  elements.heading.textContent = Math.round(headingDegrees).toString().padStart(3, "0");

  // This compact status block summarizes propulsion and aircraft loading. AOA is angle of attack:
  // the angle between the wing and the airflow, useful for judging lift and an approaching stall.
  elements.throttle.textContent = `THR ${Math.round(flight.throttle * 100)
    .toString()
    .padStart(2, "0")}%`;
  elements.bank.textContent = formatBank(rollDegrees);
  elements.lod.textContent = `LOD ${frame.terrainBands}`;
  elements.gForce.textContent = flight.gForce.toFixed(1);
  elements.alpha.textContent = Math.round(flight.alpha).toString().padStart(2, "0");

  // The side rail and movable dot echo the current throttle and pointer control inputs. They help
  // explain how keyboard or mouse input is being interpreted by the simulation.
  elements.throttleFill.style.height = `${flight.throttle * 100}%`;
  elements.stickDot.style.transform = `translate(${controls.pointerRoll * 42}px, ${
    controls.pointerPitch * 42
  }px)`;

  // The bank pointer rotates around the fixed bank scale. The flight-path marker estimates where
  // the aircraft is travelling, which can differ from where its nose is pointing at higher AOA.
  elements.bankPointer.setAttribute("transform", `rotate(${svgNumber(rollDegrees)})`);
  elements.flightPathMarker.setAttribute(
    "transform",
    `translate(${svgNumber(THREE.MathUtils.clamp(controls.yaw * 32, -44, 44))} ${svgNumber(
      THREE.MathUtils.clamp(-flight.alpha * 2.2, -44, 34),
    )})`,
  );

  if (elements.viewBadge.dataset.mode !== frame.viewMode) {
    elements.viewBadge.textContent = frame.viewMode === "chase" ? "CHASE" : "ORBIT";
    elements.viewBadge.dataset.mode = frame.viewMode;
  }

  renderPitchLadder(runtime, camera, cameraPitchDegrees, cameraHorizonRollDegrees);
  renderVerticalTape(elements.speedTicks, flight.speed, SPEED_TAPE_PARAMS);
  renderVerticalTape(elements.altitudeTicks, altitude, ALTITUDE_TAPE_PARAMS);
  renderHeadingTape(elements.headingTicks, headingDegrees);
  drawMinimap(runtime, flight);
}

// Camera pitch drives the vertical position of the horizon and pitch ladder. Clamping the asin
// input protects the HUD from tiny floating-point overshoots outside its valid -1 to +1 range.
function calcCameraPitchDegrees(runtime: HudRuntime, camera: THREE.PerspectiveCamera) {
  runtime.cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(runtime.cameraForward.y, -0.999, 0.999)),
  );
}

// Determine how the true world horizon is rotated on screen. The cross product supplies the
// horizon's right-hand direction; projecting it onto camera right/up turns that direction into a
// two-dimensional SVG rotation angle.
function calcCameraHorizonRollDegrees(runtime: HudRuntime, camera: THREE.PerspectiveCamera) {
  runtime.cameraForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  runtime.cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  runtime.cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  runtime.horizonRight.crossVectors(runtime.cameraForward, runtime.worldUp);

  // Looking almost straight up or down makes the horizon direction undefined. Keeping it level in
  // this rare case is more stable than amplifying floating-point noise.
  if (runtime.horizonRight.lengthSq() < 0.000001) {
    return 0;
  }

  runtime.horizonRight.normalize();

  let screenX = runtime.horizonRight.dot(runtime.cameraRight);
  let screenY = -runtime.horizonRight.dot(runtime.cameraUp);

  if (screenX < 0) {
    screenX = -screenX;
    screenY = -screenY;
  }

  return THREE.MathUtils.radToDeg(Math.atan2(screenY, screenX));
}

// Convert an attitude angle to an SVG y coordinate using the same perspective relationship as the
// camera. This makes ladder spacing expand naturally toward the edge of the field of view instead
// of behaving like an orthographic ruler.
function pitchAngleToHudY(
  camera: THREE.PerspectiveCamera,
  angleDegrees: number,
  cameraPitchDegrees: number,
) {
  const deltaRadians = THREE.MathUtils.degToRad(angleDegrees - cameraPitchDegrees);
  const focalScale = HUD_VIEWBOX_HALF_HEIGHT / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  return -Math.tan(deltaRadians) * focalScale;
}

// The pitch ladder shows nose attitude relative to the horizon. Positive bars are climb attitudes;
// broken negative bars are dive attitudes, and the entire ladder rolls with the visible horizon.
function renderPitchLadder(
  runtime: HudRuntime,
  camera: THREE.PerspectiveCamera,
  cameraPitchDegrees: number,
  horizonRollDegrees: number,
) {
  // Generate only the nearby five-degree marks. A moving window keeps the SVG compact even if the
  // camera is pointed far above or below the horizon.
  const centerAngle = Math.round(cameraPitchDegrees / 5) * 5;
  const startAngle = centerAngle - 45;
  const endAngle = centerAngle + 45;
  let markup = `<g transform="rotate(${svgNumber(horizonRollDegrees)})">`;

  for (let angle = startAngle; angle <= endAngle; angle += 5) {
    if (Math.abs(angle) > 85) {
      continue;
    }

    const y = pitchAngleToHudY(camera, angle, cameraPitchDegrees);

    // Marks outside the instrument's usable center region are omitted instead of being clipped
    // against other HUD components by a large blanket mask.
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

    // Dive marks are deliberately segmented, a familiar visual distinction that prevents a pilot
    // from confusing a steep descent with an equivalent climb attitude at a glance.
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
  runtime.elements.pitchLadder.innerHTML = markup;
}

// A vertical tape is a moving ruler: the center box is the current value, while surrounding ticks
// show how quickly the value is changing and how close the next major interval is.
function renderVerticalTape(
  ticksEl: SVGGElement,
  currentValue: number,
  params: VerticalTapeParams,
) {
  // Work backward from the pixel budget to the numeric range that can be visible. Starting at a
  // tick-aligned value keeps labels stable as the current reading changes by fractional amounts.
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

    // Leave the central value box unobstructed; its current reading is already more prominent than
    // the moving ruler labels behind it.
    if (isMajor && Math.abs(y) > 30) {
      markup += `<text class="hud-tape-label" x="${labelX}" y="${svgNumber(
        y + 5,
      )}" text-anchor="${labelAnchor}">${params.formatLabel(value)}</text>`;
    }
  }

  ticksEl.innerHTML = markup;
}

// The heading tape is a horizontal compass: its fixed center pointer is the current course. Degree
// wrapping allows the ruler to move continuously through north instead of jumping at 359/000.
function renderHeadingTape(headingTicks: SVGGElement, headingDegrees: number) {
  const tickStep = 5;
  const visibleDegrees = 36;
  const firstTick = Math.floor((headingDegrees - visibleDegrees) / tickStep) * tickStep;
  const lastTick = headingDegrees + visibleDegrees;
  let markup = "";

  for (let tick = firstTick; tick <= lastTick; tick += tickStep) {
    const value = wrapDegrees(tick);

    // Use the shortest signed angular difference so headings beside north appear on the correct
    // side of the tape even though their numeric values are near opposite ends of 0-360.
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

  headingTicks.innerHTML = markup;
}

// SVG is assembled as short strings because the tick sets are replaced as a unit each frame. The
// coordinate helper below guarantees that no NaN or Infinity value reaches the generated markup.
function lineSvg(x1: number, y1: number, x2: number, y2: number, className: string) {
  return `<line class="${className}" x1="${svgNumber(x1)}" y1="${svgNumber(
    y1,
  )}" x2="${svgNumber(x2)}" y2="${svgNumber(y2)}" />`;
}

// Cardinal letters are quicker to recognize than numeric compass values. Other major ticks use the
// conventional two-digit tens-of-degrees notation, so 27 represents 270 degrees.
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

// The minimap is a local situational-awareness view. Terrain colors show elevation, nested boxes
// show terrain-detail bands, and dashed lines warn that the wrapped world boundary is nearby.
function drawMinimap(runtime: HudRuntime, flight: HudFlightData) {
  const size = runtime.minimapCanvas.width;
  const padding = 7;
  const mapSize = size - padding * 2;
  const center = size * 0.5;
  const { minimapContext } = runtime;

  minimapContext.clearRect(0, 0, size, size);

  // The sampled terrain is drawn first. Crosshairs, LOD footprints, boundary warnings, and the
  // aircraft icon are overlays, so their line work stays crisp above the enlarged raster image.
  drawMinimapTerrain(runtime, flight.position.x, flight.position.z);
  minimapContext.drawImage(runtime.minimapTerrainCanvas, padding, padding, mapSize, mapSize);
  minimapContext.fillStyle = "rgba(5, 12, 18, 0.18)";
  minimapContext.fillRect(padding, padding, mapSize, mapSize);

  minimapContext.strokeStyle = "rgba(125, 229, 255, 0.22)";
  minimapContext.lineWidth = 1;
  minimapContext.beginPath();
  minimapContext.moveTo(size * 0.5, padding);
  minimapContext.lineTo(size * 0.5, size - padding);
  minimapContext.moveTo(padding, size * 0.5);
  minimapContext.lineTo(size - padding, size * 0.5);
  minimapContext.stroke();

  drawMinimapLodFootprint(minimapContext, padding, mapSize);
  drawMinimapWrapBoundaries(minimapContext, flight.position, padding, mapSize);

  minimapContext.strokeStyle = "rgba(255, 231, 157, 0.9)";
  minimapContext.lineWidth = 2;
  minimapContext.strokeRect(padding + 1, padding + 1, mapSize - 2, mapSize - 2);

  runtime.forward.set(0, 0, -1).applyQuaternion(flight.quaternion);
  const heading = Math.atan2(runtime.forward.x, runtime.forward.z);
  drawMinimapAircraft(minimapContext, center, center, heading, 1);
}

// Sample the same procedural height function used by the 3D terrain. Pixel rows run downward while
// world Z runs forward, hence the reversed vertical mapping in worldZ.
function drawMinimapTerrain(runtime: HudRuntime, centerX: number, centerZ: number) {
  const image = runtime.minimapTerrainContext.createImageData(
    MINIMAP_TEXTURE_SIZE,
    MINIMAP_TEXTURE_SIZE,
  );

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

  runtime.minimapTerrainContext.putImageData(image, 0, 0);
}

// These nested squares show how far the sharper terrain bands extend around the aircraft. They are
// diagnostics for the demo's level-of-detail system, not radar range rings.
function drawMinimapLodFootprint(
  minimapContext: CanvasRenderingContext2D,
  padding: number,
  mapSize: number,
) {
  const sharpSpan = (TERRAIN_LEVELS[1].outer / MINIMAP_WORLD_SPAN) * mapSize;
  const midSpan = (TERRAIN_LEVELS[2].outer / MINIMAP_WORLD_SPAN) * mapSize;
  const center = padding + mapSize * 0.5;

  minimapContext.strokeStyle = "rgba(125, 229, 255, 0.2)";
  minimapContext.lineWidth = 1;
  minimapContext.strokeRect(center - midSpan * 0.5, center - midSpan * 0.5, midSpan, midSpan);
  minimapContext.strokeStyle = "rgba(125, 229, 255, 0.4)";
  minimapContext.strokeRect(center - sharpSpan * 0.5, center - sharpSpan * 0.5, sharpSpan, sharpSpan);
}

// The terrain repeats after crossing the world-wrap radius. Show an approaching seam only when it
// falls inside the current minimap span, and use a dashed line to distinguish it from terrain LOD.
function drawMinimapWrapBoundaries(
  minimapContext: CanvasRenderingContext2D,
  position: THREE.Vector3,
  padding: number,
  mapSize: number,
) {
  const halfSpan = MINIMAP_WORLD_SPAN * 0.5;

  minimapContext.save();
  minimapContext.strokeStyle = "rgba(255, 231, 157, 0.75)";
  minimapContext.lineWidth = 2;
  minimapContext.setLineDash([5, 4]);

  for (const boundary of [-WORLD_WRAP_RADIUS, WORLD_WRAP_RADIUS]) {
    const dx = boundary - position.x;
    if (Math.abs(dx) <= halfSpan) {
      const x = padding + (dx / MINIMAP_WORLD_SPAN + 0.5) * mapSize;
      minimapContext.beginPath();
      minimapContext.moveTo(x, padding);
      minimapContext.lineTo(x, padding + mapSize);
      minimapContext.stroke();
    }

    const dz = boundary - position.z;
    if (Math.abs(dz) <= halfSpan) {
      const y = padding + (0.5 - dz / MINIMAP_WORLD_SPAN) * mapSize;
      minimapContext.beginPath();
      minimapContext.moveTo(padding, y);
      minimapContext.lineTo(padding + mapSize, y);
      minimapContext.stroke();
    }
  }

  minimapContext.restore();
}

// Use broad elevation bands rather than satellite-style imagery so the map shares the deliberately
// graphic, low-poly palette of the main scene.
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

// Draw the player at map center and rotate the icon into its current heading. The world scrolls
// beneath this fixed reference, matching the pilot-centered presentation of the chase camera.
function drawMinimapAircraft(
  minimapContext: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  alpha: number,
) {
  minimapContext.save();
  minimapContext.translate(x, y);
  minimapContext.rotate(heading);
  minimapContext.globalAlpha = alpha;
  minimapContext.fillStyle = "#ffe79d";
  minimapContext.strokeStyle = "#07121b";
  minimapContext.lineWidth = 1.5;
  minimapContext.beginPath();
  minimapContext.moveTo(0, -8);
  minimapContext.lineTo(6, 7);
  minimapContext.lineTo(0, 4);
  minimapContext.lineTo(-6, 7);
  minimapContext.closePath();
  minimapContext.fill();
  minimapContext.stroke();
  minimapContext.restore();
}

function positiveDegrees(radians: number) {
  return ((THREE.MathUtils.radToDeg(radians) % 360) + 360) % 360;
}

function mustElement<T extends Element>(root: ParentNode, selector: string) {
  const element = root.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing ${selector} element`);
  }

  return element;
}
