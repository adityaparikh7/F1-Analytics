/**
 * Race Replay — 3D view (lazy-loaded: three.js only downloads when someone opens it).
 *
 * The track is a ribbon on its real GPS elevation (exaggerated by the slider; flat for replays
 * built before elevation was recorded). Cars are team-coloured bodies with a marker above them
 * that grows with distance, so they stay findable from the overview.
 *
 * Rendering is on demand: the playback clock's per-frame callback stores the time and asks for a
 * frame; `useFrame` then moves cars and the camera through refs. React never re-renders per frame.
 *
 * Cameras: Orbit (free; eases onto the followed car), Helicopter, Chase, and TV (a trackside
 * camera per corner, cutting between them as the car moves round). Following falls back to the
 * leader when nobody is selected. Changing camera or car eases over 0.6 s; TV cuts are hard.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { cssVar, ensureReadable, getTrackStatusColour } from '../../lib/colours';
import type { CarPose } from '../carPose';
import { carPose } from '../carPose';
import type { Replay } from '../decode';
import { carOpacity, leaderCar } from '../replayMath';
import type { TrackGeometry } from '../trackGeometry';
import { pointAt } from '../trackGeometry';
import type { CameraMode } from '../uiState';
import type { CornerStation, Shot, Vec3 } from './cameras';
import { chaseShot, cornerStations, helicopterShot, overviewShot, pickStation, tvShot } from './cameras';
import { baseElevation, startLineQuad, toWorld, trackRibbon } from './ribbon';

interface Props {
  replay: Replay;
  geometry: TrackGeometry;
  subscribe: (cb: (t: number) => void) => () => void;
  focus: string | null;
  rival: string | null;
  battles: Set<string>;
  camera: CameraMode;
  /** Elevation exaggeration; ignored when the replay has no elevation. */
  elevation: number;
  labels: boolean;
  statusKind: string | null;
  /** Playback speed, so TV cuts can be held longer when time flies. */
  speed: number;
  onSelect: (abbr: string, shift: boolean) => void;
}

const TINTED = new Set(['sc', 'vsc', 'vsc_ending', 'red']);
const TWEEN_MS = 600;
/** Above this playback speed a TV camera is held at least this long on screen. */
const TV_FAST_SPEED = 10;
const TV_MIN_HOLD_MS = 1500;
/** Car markers hide when the camera is closer than this. */
const MARKER_MIN_DIST_M = 40;

function meshGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals();
  return geom;
}

const TrackScene: React.FC<{ geometry: TrackGeometry; k: number; z0: number; statusKind: string | null }> = ({
  geometry,
  k,
  z0,
  statusKind,
}) => {
  const ribbon = useMemo(() => {
    const { positions, indices } = trackRibbon(geometry, k, z0);
    return meshGeometry(positions, indices);
  }, [geometry, k, z0]);
  const startLine = useMemo(() => {
    const { positions, indices } = startLineQuad(geometry, k, z0);
    return meshGeometry(positions, indices);
  }, [geometry, k, z0]);
  const centreLine = useMemo(() => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= geometry.n; i++) {
      const j = i % geometry.n;
      const p = toWorld(geometry.x[j], geometry.y[j], geometry.z ? geometry.z[j] : 0, k, z0);
      p[1] += 0.08;
      pts.push(p);
    }
    return pts;
  }, [geometry, k, z0]);
  const span = useMemo(() => {
    let max = 0;
    for (let i = 0; i < geometry.n; i++) max = Math.max(max, Math.abs(geometry.x[i]), Math.abs(geometry.y[i]));
    return max * 4 + 2000;
  }, [geometry]);
  const tint = statusKind && TINTED.has(statusKind) ? getTrackStatusColour(statusKind) : cssVar('--text-tertiary');

  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position={[0, -3.5, 0]}>
        <planeGeometry args={[span, span]} />
        <meshStandardMaterial color={cssVar('--bg-panel')} />
      </mesh>
      <mesh geometry={ribbon}>
        <meshStandardMaterial color={cssVar('--bg-active')} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={startLine}>
        <meshBasicMaterial color={cssVar('--text-primary')} side={THREE.DoubleSide} />
      </mesh>
      <Line points={centreLine} color={tint} lineWidth={1.5} />
    </>
  );
};

const Cars: React.FC<
  Pick<Props, 'replay' | 'geometry' | 'focus' | 'rival' | 'battles' | 'onSelect'> & {
    k: number;
    z0: number;
    tRef: React.RefObject<number>;
    /** Written each frame: where each car is (null when hidden), for the label overlay. */
    positions: React.RefObject<Map<string, THREE.Vector3 | null>>;
  }
> = ({ replay, geometry, focus, rival, battles, onSelect, k, z0, tRef, positions }) => {
  const groups = useRef(new Map<string, THREE.Group>());
  const markers = useRef(new Map<string, THREE.Object3D>());
  const colours = useMemo(
    () => new Map(replay.drivers.map(d => [d.abbr, ensureReadable(d.colour)])),
    [replay]
  );

  useFrame(state => {
    const t = tRef.current ?? 0;
    for (const drv of replay.drivers) {
      const group = groups.current.get(drv.abbr);
      if (!group) continue;
      const pose = carOpacity(drv, t) > 0 ? carPose(replay, geometry, drv, t) : null;
      if (!pose) {
        group.visible = false;
        positions.current.set(drv.abbr, null);
        continue;
      }
      group.visible = true;
      const [x, y, z] = toWorld(pose.x, pose.y, pose.z, k, z0);
      group.position.set(x, y + 0.6, z);
      positions.current.set(drv.abbr, group.position);
      group.rotation.y = pose.heading;
      // The floating marker is for spotting cars from afar; up close (chase, TV) it only gets in the way.
      const marker = markers.current.get(drv.abbr);
      if (marker) {
        const dist = state.camera.position.distanceTo(group.position);
        marker.visible = dist > MARKER_MIN_DIST_M;
        marker.scale.setScalar(Math.max(1, dist / 120));
      }
    }
  });

  return (
    <>
      {replay.drivers.map(drv => {
        const isFocus = drv.abbr === focus;
        const isRival = drv.abbr === rival;
        const inBattle = battles.has(drv.abbr);
        const colour = colours.get(drv.abbr) ?? drv.colour;
        return (
          <group
            key={drv.abbr}
            ref={el => {
              if (el) groups.current.set(drv.abbr, el);
              else groups.current.delete(drv.abbr);
            }}
            visible={false}
            onClick={e => {
              e.stopPropagation();
              onSelect(drv.abbr, e.nativeEvent.shiftKey);
            }}
          >
            <mesh>
              <boxGeometry args={[5.5, 1.1, 2]} />
              <meshStandardMaterial color={colour} />
            </mesh>
            <group
              ref={el => {
                if (el) markers.current.set(drv.abbr, el);
                else markers.current.delete(drv.abbr);
              }}
              position={[0, 5, 0]}
            >
              <mesh>
                <sphereGeometry args={[1.6, 16, 12]} />
                <meshBasicMaterial color={colour} />
              </mesh>
              {(isFocus || isRival || inBattle) && (
                <mesh rotation-x={Math.PI / 2}>
                  <torusGeometry args={[2.6, isFocus ? 0.35 : 0.22, 8, 32]} />
                  <meshBasicMaterial color={inBattle && !isFocus && !isRival ? cssVar('--accent-amber') : cssVar('--text-primary')} />
                </mesh>
              )}
            </group>
          </group>
        );
      })}
    </>
  );
};

interface RigState {
  key: string;
  from: { position: THREE.Vector3; target: THREE.Vector3; fov: number } | null;
  startedAt: number;
  station: string | null;
  stationSince: number;
  target: THREE.Vector3;
}

const CameraRig: React.FC<
  Pick<Props, 'replay' | 'geometry' | 'focus' | 'camera' | 'speed'> & {
    k: number;
    z0: number;
    tRef: React.RefObject<number>;
    stations: CornerStation[];
  }
> = ({ replay, geometry, focus, camera, speed, k, z0, tRef, stations }) => {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const rig = useRef<RigState>({
    key: '',
    from: null,
    startedAt: 0,
    station: null,
    stationSince: 0,
    target: new THREE.Vector3(),
  });
  const get = useThree(s => s.get);

  // Start from the overview, looking down on the whole circuit.
  useEffect(() => {
    const { camera: cam, invalidate } = get();
    const shot = overviewShot(geometry, k, z0);
    cam.position.set(...shot.position);
    rig.current.target.set(...shot.target);
    cam.lookAt(rig.current.target);
    invalidate();
  }, [geometry, k, z0, get]);

  // Orbit takes over from wherever the previous camera was looking.
  useEffect(() => {
    if (camera !== 'orbit' || !controls.current) return;
    controls.current.target.copy(rig.current.target);
    controls.current.update();
    get().invalidate();
  }, [camera, get]);

  useFrame(({ camera: cam, invalidate }, delta) => {
    const t = tRef.current ?? 0;
    const state = rig.current;
    const drv = (focus ? replay.byAbbr.get(focus) : undefined) ?? leaderCar(replay, t);
    const pose: CarPose | null = drv ? carPose(replay, geometry, drv, t) : null;
    const now = performance.now();

    if (camera === 'orbit') {
      // Free camera; its pivot eases onto the followed car.
      if (pose && controls.current) {
        const goal = new THREE.Vector3(...toWorld(pose.x, pose.y, pose.z, k, z0));
        const ease = 1 - Math.exp(-delta * 3);
        const step = goal.clone().sub(controls.current.target).multiplyScalar(ease);
        controls.current.target.add(step);
        cam.position.add(step);
        controls.current.update();
        state.target.copy(controls.current.target);
        if (step.lengthSq() > 0.01) invalidate();
      }
      state.key = 'orbit';
      return;
    }
    if (!pose) return;

    let shot: Shot;
    let key = `${camera}:${drv?.abbr}`;
    if (camera === 'tv') {
      let station = pickStation(stations, pose.s, geometry.perimeter, state.station);
      const held = state.station && speed > TV_FAST_SPEED && now - state.stationSince < TV_MIN_HOLD_MS;
      if (held) station = stations.find(s => s.key === state.station) ?? station;
      if (station?.key !== state.station) {
        state.station = station?.key ?? null;
        state.stationSince = now;
      }
      shot = station ? tvShot(station, pose, k, z0) : helicopterShot(geometry, pose, k, z0);
      // Cuts between stations are hard: only a change of camera mode or car eases.
      key = `tv:${drv?.abbr}`;
    } else {
      shot = camera === 'helicopter' ? helicopterShot(geometry, pose, k, z0) : chaseShot(geometry, pose, k, z0);
    }

    if (key !== state.key) {
      state.from = { position: cam.position.clone(), target: state.target.clone(), fov: (cam as THREE.PerspectiveCamera).fov };
      state.startedAt = now;
      state.key = key;
    }
    const goalPos = new THREE.Vector3(...shot.position);
    const goalTarget = new THREE.Vector3(...shot.target);
    let fov = shot.fov;
    const raw = (now - state.startedAt) / TWEEN_MS;
    if (state.from && raw < 1) {
      const e = raw * raw * (3 - 2 * raw);
      goalPos.lerpVectors(state.from.position, goalPos, e);
      goalTarget.lerpVectors(state.from.target, goalTarget, e);
      fov = state.from.fov + (fov - state.from.fov) * e;
      invalidate();
    }
    cam.position.copy(goalPos);
    state.target.copy(goalTarget);
    cam.lookAt(goalTarget);
    const persp = cam as THREE.PerspectiveCamera;
    if (Math.abs(persp.fov - fov) > 0.01) {
      persp.fov = fov;
      persp.updateProjectionMatrix();
    }
  });

  return camera === 'orbit' ? (
    <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} />
  ) : null;
};

/** Hooks the playback clock to the canvas: store the time, request a frame. */
const ClockBridge: React.FC<{ subscribe: Props['subscribe']; tRef: React.RefObject<number> }> = ({ subscribe, tRef }) => {
  const invalidate = useThree(s => s.invalidate);
  useEffect(
    () =>
      subscribe(t => {
        tRef.current = t;
        invalidate();
      }),
    [subscribe, invalidate, tRef]
  );
  return null;
};

/**
 * Positions the DOM label overlay each frame by projecting 3D points to the screen. Plain DOM
 * rather than drei's <Html>, which mounts a React root per label (and React 19 objects to those
 * roots being torn down while the view unmounts).
 */
const LabelProjector: React.FC<{
  cars: React.RefObject<Map<string, THREE.Vector3 | null>>;
  carLabels: React.RefObject<Map<string, HTMLSpanElement>>;
  corners: { key: string; position: Vec3 }[];
  cornerLabels: React.RefObject<Map<string, HTMLSpanElement>>;
}> = ({ cars, carLabels, corners, cornerLabels }) => {
  const scratch = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const place = (el: HTMLSpanElement | undefined, x: number, y: number, z: number) => {
      if (!el) return;
      scratch.set(x, y, z).project(camera);
      if (scratch.z > 1 || Math.abs(scratch.x) > 1.2 || Math.abs(scratch.y) > 1.2) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = 'visible';
      el.style.transform = `translate(${((scratch.x + 1) / 2) * size.width}px, ${((1 - scratch.y) / 2) * size.height}px) translate(-50%, -100%)`;
    };
    for (const [abbr, pos] of cars.current) {
      const el = carLabels.current.get(abbr);
      if (!pos) {
        if (el) el.style.visibility = 'hidden';
        continue;
      }
      place(el, pos.x, pos.y + 9, pos.z);
    }
    for (const c of corners) place(cornerLabels.current.get(c.key), c.position[0], c.position[1] + 4, c.position[2]);
  });
  return null;
};

const labelBase: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

const Replay3DView: React.FC<Props> = props => {
  const { replay, geometry, camera, elevation } = props;
  const k = replay.elevation ? elevation : 1;
  const z0 = useMemo(() => baseElevation(geometry), [geometry]);
  const stations = useMemo(() => cornerStations(replay.corners, geometry, k, z0), [replay, geometry, k, z0]);
  const cornerPoints = useMemo(
    () =>
      stations.map(st => {
        const [x, y, z] = pointAt(geometry, st.s);
        return { key: st.key, position: toWorld(x, y, z, k, z0) };
      }),
    [stations, geometry, k, z0]
  );
  const tRef = useRef(0);
  const carPositions = useRef(new Map<string, THREE.Vector3 | null>());
  const carLabels = useRef(new Map<string, HTMLSpanElement>());
  const cornerLabels = useRef(new Map<string, HTMLSpanElement>());
  const showAllLabels = props.labels && camera === 'orbit';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ logarithmicDepthBuffer: true, antialias: true }}
        camera={{ fov: 45, near: 0.5, far: 60000 }}
        style={{ background: cssVar('--bg-page'), borderRadius: 'var(--radius-md)' }}
      >
        <ClockBridge subscribe={props.subscribe} tRef={tRef} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[2000, 4000, 1500]} intensity={1.1} />
        <TrackScene geometry={geometry} k={k} z0={z0} statusKind={props.statusKind} />
        <Cars {...props} k={k} z0={z0} tRef={tRef} positions={carPositions} />
        <CameraRig {...props} k={k} z0={z0} tRef={tRef} stations={stations} />
        <LabelProjector cars={carPositions} carLabels={carLabels} corners={cornerPoints} cornerLabels={cornerLabels} />
      </Canvas>
      {showAllLabels &&
        cornerPoints.map(c => (
          <span
            key={c.key}
            ref={el => {
              if (el) cornerLabels.current.set(c.key, el);
              else cornerLabels.current.delete(c.key);
            }}
            className="mono"
            style={{ ...labelBase, fontSize: 9, color: 'var(--text-tertiary)' }}
          >
            {c.key}
          </span>
        ))}
      {replay.drivers.map(drv => {
        const show = showAllLabels || drv.abbr === props.focus || drv.abbr === props.rival || props.battles.has(drv.abbr);
        if (!show) return null;
        return (
          <span
            key={drv.abbr}
            ref={el => {
              if (el) carLabels.current.set(drv.abbr, el);
              else carLabels.current.delete(drv.abbr);
            }}
            className="mono"
            style={{
              ...labelBase,
              padding: '1px 5px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 700,
              background: 'var(--bg-panel)',
              color: 'var(--text-primary)',
              border: `1px solid ${ensureReadable(drv.colour)}`,
            }}
          >
            {drv.abbr}
          </span>
        );
      })}
    </div>
  );
};

export default Replay3DView;
