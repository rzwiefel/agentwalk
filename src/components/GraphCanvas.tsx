import { Billboard, Html, OrbitControls, Stars, Text } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ActivityAgentLayout, CodeEdge, CodeGraph, CodeNode, ConnectionMode, GraphPositions, LayoutGroup, NodeVisibilityMode, NodeVisibilityModes } from '../types';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { nodeColor, nodePulseColor } from '../theme';
import { nodeSizeFactor } from '../nodeSizing';
import { connectionScore, type NamespaceMetrics } from '../namespaceMetrics';
import { displayLabel, displayLabels, displayNamespaceLabel, filterEdgesByVisibleNodes, filterTopLevelFolderConnections } from '../graph';
import { historyFadeValue, type HistoryActivity, type HistoryFrame } from '../history';
import { createPhysicsState, stepPhysics, type PhysicsState } from '../physics';
import { isGlobalNode, isTestNamespaceName, isTestNode, testNamespacesForGraph } from '../namespaceVisibility';
import type { ActivityPulse, ActivityRay, ActivitySnippetMarker as ActivitySnippetMarkerData } from '../activity/types';
import { ACTIVITY_PULSE_COLORS, ACTIVITY_SNIPPET_MARKER_HOLD_MS, ACTIVITY_SNIPPET_MARKER_TTL_MS, ACTIVITY_TARGET_BASELINE_OPACITY, ACTIVITY_TARGET_FADE_MS, ACTIVITY_TARGET_HOLD_MS } from '../activity/reducer';
import { ACTIVITY_AGENT_GLYPH_SCALE, ACTIVITY_GROUP_FADE_MS, ACTIVITY_GROUP_RETENTION_MS } from '../layout';

const FULL_OPACITY_VISIBILITY_MODES: NodeVisibilityModes = { var: 'always', keyword: 'always' };
const DEFAULT_CAMERA_POSITION: [number, number, number] = [0, 58, 170];
const ACTIVITY_CAMERA_POSITION: [number, number, number] = [0, 190, 280];
const ACTIVITY_CAMERA_TARGET: [number, number, number] = [0, 110, 0];
export const ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS = 6000;
export const ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS = 6000;
export const ACTIVITY_SNIPPET_MARKER_MAX_SCALE = 2.5;

// --- W1.5-CANVAS: pure activity-visual helpers, unit-tested in activityCanvas.test.ts. ---
// Kept free of React/three-specific types so they stay trivially testable.

/** Fraction opacity for anything belonging to a dimmed session (T1-G "dim others"). */
export const ACTIVITY_DIMMED_OPACITY_FACTOR = 0.25;
const EMPTY_DIMMED_SESSION_IDS: ReadonlySet<string> = new Set();

export function activityDimFactor(sessionId: string | undefined, dimmedSessionIds: ReadonlySet<string> | undefined): number {
  if (!sessionId || !dimmedSessionIds || dimmedSessionIds.size === 0) return 1;
  return dimmedSessionIds.has(sessionId) ? ACTIVITY_DIMMED_OPACITY_FACTOR : 1;
}

export function shouldRenderInactiveAgents(activityMode: boolean, showInactiveAgents: boolean): boolean {
  return activityMode && showInactiveAgents;
}

const ACTIVITY_FOLLOW_EASE = 0.08;
const ACTIVITY_FOLLOW_INTERACTION_PAUSE_MS = 2000;

/** `web`/`domain` activity groups render as spheres (T2-C); every other group keeps its box. */
export type ActivityGroupGeometryKind = 'sphere' | 'box';

export function groupGeometryKind(activityKind: string | undefined): ActivityGroupGeometryKind {
  return activityKind === 'web' || activityKind === 'domain' ? 'sphere' : 'box';
}

/** Domain sphere label: the host, plus "· N" only once the group exposes a positive hit count. */
export function domainGroupLabel(label: string, hitCount: number | undefined): string {
  return hitCount !== undefined && hitCount > 0 ? `${label} · ${hitCount}` : label;
}

// T2-D remainder: tint family (tests/git/build) toolbox boxes and domain
// spheres by their last reported outcome (src/layout.ts's activityGroupSpecs
// sets `lastOutcome` on the group spec; withActivityGroups forwards it onto
// LayoutGroup.activity). Reuses the existing palette instead of inventing new
// colours: ACTIVITY_PULSE_COLORS.failed for a failing run, and the same
// teal-green PhysicsEdges below already uses for a "calls" edge for a passing
// one -- ACTIVITY_PULSE_COLORS has no pre-existing "success" entry to reuse
// instead, since its kinds are all action kinds (read/write/search/execute/
// session/network) plus the one outcome kind, failed.
const ACTIVITY_GROUP_OUTCOME_OK_COLOR = '#47d7b0';

/** Tint for a group's last reported outcome, or undefined when it has none yet (T2-D). */
export function activityGroupOutcomeColor(lastOutcome: 'completed' | 'failed' | undefined): string | undefined {
  if (lastOutcome === 'failed') return ACTIVITY_PULSE_COLORS.failed;
  if (lastOutcome === 'completed') return ACTIVITY_GROUP_OUTCOME_OK_COLOR;
  return undefined;
}

/** Failed pulses render slightly larger than every other kind. */
export function activityPulseSizeScale(kind: ActivityPulse['kind']): number {
  return kind === 'failed' ? 1.3 : 1;
}

export const ACTIVITY_AGENT_DENIED_FLASH_MS = 3000;
const ACTIVITY_AGENT_HALO_WAITING_COLOR = '#f5b942';
const ACTIVITY_AGENT_HALO_ALERT_COLOR = '#ff5c68';

export type ActivityAgentHaloKind = 'waiting' | 'denied' | 'failed' | null;

export interface ActivityAgentAppearanceInput {
  status: string;
  waitingSince?: number;
  lastDeniedAt?: number;
}

/**
 * Which halo ring (if any) an agent glyph should show, and its color (T1-B).
 * Priority: a recent denial flashes red for ACTIVITY_AGENT_DENIED_FLASH_MS, then an
 * open wait shows the amber ring, then a failed/error status keeps a red ring, else none.
 */
export function agentGlyphAppearance(agent: ActivityAgentAppearanceInput, now = Date.now()): { halo: ActivityAgentHaloKind; color: string } {
  const deniedElapsed = agent.lastDeniedAt !== undefined ? now - agent.lastDeniedAt : Infinity;
  if (deniedElapsed >= 0 && deniedElapsed < ACTIVITY_AGENT_DENIED_FLASH_MS) {
    return { halo: 'denied', color: ACTIVITY_AGENT_HALO_ALERT_COLOR };
  }
  const status = agent.status.toLowerCase();
  if (status === 'waiting' || agent.waitingSince !== undefined) {
    return { halo: 'waiting', color: ACTIVITY_AGENT_HALO_WAITING_COLOR };
  }
  if (status === 'failed' || status === 'error') {
    return { halo: 'failed', color: ACTIVITY_AGENT_HALO_ALERT_COLOR };
  }
  return { halo: null, color: ACTIVITY_AGENT_HALO_ALERT_COLOR };
}

const shockwaveVertexShader = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

const shockwaveFragmentShader = [
  'uniform vec3 uColor;',
  'uniform float uProgress;',
  'uniform float uOpacity;',
  'varying vec2 vUv;',
  'void main() {',
  '  float distanceFromCenter = length(vUv - vec2(0.5)) * 2.0;',
  '  float ringRadius = 0.04 + uProgress * 0.88;',
  '  float ringWidth = 0.055 + (1.0 - uProgress) * 0.035;',
  '  float ringDistance = abs(distanceFromCenter - ringRadius);',
  '  float ring = 1.0 - smoothstep(ringWidth, ringWidth * 2.0, ringDistance);',
  '  float halo = 1.0 - smoothstep(ringWidth * 2.0, ringWidth * 7.0, ringDistance);',
  '  float circle = 1.0 - smoothstep(0.88, 1.0, distanceFromCenter);',
  '  float alpha = (ring * 0.9 + halo * 0.22) * circle * uOpacity;',
  '  if (alpha < 0.001) discard;',
  '  gl_FragColor = vec4(uColor, alpha);',
  '}',
].join('\n');

interface GraphCanvasProps {
  graph: CodeGraph;
  positions: GraphPositions;
  groups: LayoutGroup[];
  showHierarchy: boolean;
  hierarchyLeavesOnly: boolean;
  heatEnabled: boolean;
  heatLevels: Map<string, number>;
  fullOpacity: boolean;
  connectionMode: ConnectionMode;
  namespaceMetrics: Map<string, NamespaceMetrics>;
  physicsEnabled: boolean;
  selectedId: string | null;
  selectedGroupId: string | null;
  focusedIds: Set<string> | null;
  searchMatchIds: Set<string> | null;
  visibleKinds: Set<CodeNode['kind']>;
  visibilityModes: NodeVisibilityModes;
  relationshipVisibilityMode: NodeVisibilityMode;
  showExternal: boolean;
  showTestNamespaces: boolean;
  showGlobalNamespace: boolean;
  orbitGlobalNamespace: boolean;
  showTopLevelFolderConnections: boolean;
  edgeVisibility: Record<CodeEdge['kind'], boolean>;
  showLabels: boolean;
  nodeScale: number;
  resetSignal: number;
  activeHistoryFrame: HistoryFrame | null;
  historyNodeOrder: string[];
  historyElapsed: number;
  historyStepMs: number;
  historyRevealedNodeIds: Set<string>;
  historyAddedNodeIds: Set<string>;
  historyActivity: HistoryActivity | null;
  activityMode: boolean;
  showInactiveAgents: boolean;
  showArchitectureContext: boolean;
  activityAgents: ActivityAgentLayout[];
  activityInactiveAgents: ActivityAgentLayout[];
  activityPulses: ActivityPulse[];
  activityRays: ActivityRay[];
  activitySnippetMarkers: ActivitySnippetMarkerData[];
  activeActivityNodeIds: Set<string>;
  activeActivityGroupIds: Set<string>;
  /** While set, eases the OrbitControls target toward this point (~0.08/frame); pauses for 2s after any user drag (T1-G). Optional — omitting it leaves the camera untouched. */
  followTarget?: [number, number, number] | null;
  /** Session ids to render at ~25% opacity across agents, rays, pulses, and snippet markers (T1-G). Optional — omitting it dims nothing. */
  dimmedSessionIds?: ReadonlySet<string>;
  continuousRendering: boolean;
  onSelect: (id: string) => void;
  onSelectGroup: (id: string) => void;
  onFocus: (id: string) => void;
}

function CameraReset({ signal, controlsRef, activityMode }: { signal: number; controlsRef: RefObject<OrbitControlsImpl | null>; activityMode: boolean }) {
  const { camera } = useThree();
  useEffect(() => {
    const position = activityMode ? ACTIVITY_CAMERA_POSITION : DEFAULT_CAMERA_POSITION;
    const target: [number, number, number] = activityMode ? ACTIVITY_CAMERA_TARGET : [0, 0, 0];
    camera.position.set(...position);
    camera.lookAt(...target);
    controlsRef.current?.target.set(...target);
    controlsRef.current?.update();
  }, [activityMode, camera, controlsRef, signal]);
  return null;
}

function textInputActive() {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
}

function CameraMotion({ controlsRef }: { controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const { camera, invalidate } = useThree();
  const keys = useRef(new Set<string>());
  const direction = useRef(new THREE.Vector3());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (textInputActive()) return;
      const movementKey = ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(event.code);
      const modifierKey = event.code === 'ShiftLeft' || event.code === 'ShiftRight';
      if (!movementKey && !modifierKey) return;
      if (movementKey) event.preventDefault();
      keys.current.add(event.code);
      invalidate();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keys.current.delete(event.code);
      invalidate();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      keys.current.clear();
    };
  }, [invalidate]);

  useFrame((_, delta) => {
    const forward = keys.current.has('KeyW') || keys.current.has('ArrowUp');
    const backward = keys.current.has('KeyS') || keys.current.has('ArrowDown');
    const directionSign = (forward ? 1 : 0) - (backward ? 1 : 0);
    if (directionSign === 0) return;
    camera.getWorldDirection(direction.current);
    const boost = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') ? 2 : 1;
    const distance = delta * 18 * boost * directionSign;
    camera.position.addScaledVector(direction.current, distance);
    if (controlsRef.current) {
      controlsRef.current.target.addScaledVector(direction.current, distance);
      controlsRef.current.update();
    }
    invalidate();
  });
  return null;
}

/** Eases the OrbitControls target toward `target` while set; pauses during and for 2s after any user drag (T1-G). */
function CameraFollow({ controlsRef, target }: { controlsRef: RefObject<OrbitControlsImpl | null>; target: [number, number, number] | null }) {
  const { invalidate } = useThree();
  const interactingRef = useRef(false);
  const pausedUntilRef = useRef(0);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const onStart = () => { interactingRef.current = true; };
    const onEnd = () => {
      interactingRef.current = false;
      pausedUntilRef.current = Date.now() + ACTIVITY_FOLLOW_INTERACTION_PAUSE_MS;
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);
    return () => {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
    };
  }, [controlsRef]);
  useFrame(() => {
    if (!target) return;
    const controls = controlsRef.current;
    if (!controls) return;
    if (interactingRef.current || Date.now() < pausedUntilRef.current) return;
    controls.target.set(
      THREE.MathUtils.lerp(controls.target.x, target[0], ACTIVITY_FOLLOW_EASE),
      THREE.MathUtils.lerp(controls.target.y, target[1], ACTIVITY_FOLLOW_EASE),
      THREE.MathUtils.lerp(controls.target.z, target[2], ACTIVITY_FOLLOW_EASE),
    );
    controls.update();
    invalidate();
  });
  return null;
}

function boxEdgePoints(size: [number, number, number]): Array<[number, number, number]> {
  const [x, y, z] = size.map(value => value / 2) as [number, number, number];
  const a: [number, number, number] = [-x, -y, -z];
  const b: [number, number, number] = [x, -y, -z];
  const c: [number, number, number] = [x, y, -z];
  const d: [number, number, number] = [-x, y, -z];
  const e: [number, number, number] = [-x, -y, z];
  const f: [number, number, number] = [x, -y, z];
  const g: [number, number, number] = [x, y, z];
  const h: [number, number, number] = [-x, y, z];
  return [a, b, b, c, c, d, d, a, e, f, f, g, g, h, h, e, a, e, b, f, c, g, d, h];
}

function activityValue(activity: HistoryActivity | null, id: string | undefined) {
  if (!activity) return 1;
  return id ? activity.values.get(id) ?? activity.baseline : activity.baseline;
}

const RELATIONSHIP_FADE_MS = 6000;

function relationshipActivity(edge: CodeEdge, historyActivity: HistoryActivity | null) {
  if (!historyActivity) return 1;
  return Math.max(
    historyFadeValue(historyActivity, edge.source, RELATIONSHIP_FADE_MS),
    historyFadeValue(historyActivity, edge.target, RELATIONSHIP_FADE_MS),
  );
}

function relationshipIsVisible(edge: CodeEdge, historyActivity: HistoryActivity | null, activeHistoryFrame: HistoryFrame | null, historyRevealedNodeIds: Set<string>) {
  if (!historyActivity) return true;
  if (relationshipActivity(edge, historyActivity) <= 0) return false;
  if (edge.kind === 'requires' && activeHistoryFrame?.edgeChangesKnown) {
    return activeHistoryFrame.changedEdgeIds.has(edge.id)
      && (activityIsVisible(edge.source, historyActivity, activeHistoryFrame, historyRevealedNodeIds)
        || activityIsVisible(edge.target, historyActivity, activeHistoryFrame, historyRevealedNodeIds));
  }
  return activityIsVisible(edge.source, historyActivity, activeHistoryFrame, historyRevealedNodeIds)
    || activityIsVisible(edge.target, historyActivity, activeHistoryFrame, historyRevealedNodeIds);
}

function relationshipChanged(edge: CodeEdge, activeHistoryFrame: HistoryFrame | null) {
  if (!activeHistoryFrame) return false;
  if (edge.kind === 'requires' && activeHistoryFrame.edgeChangesKnown) {
    return activeHistoryFrame.changedEdgeIds.has(edge.id);
  }
  return activeHistoryFrame.changedNodeIds.has(edge.source) || activeHistoryFrame.changedNodeIds.has(edge.target);
}

const RECENCY_FADE_COLOR = new THREE.Color('#7f899e');

// `out` lets hot per-frame callers reuse a scratch Color instead of allocating
// a fresh one every call; callers that omit it keep getting a fresh Color, so
// existing render-time (non-per-frame) call sites are unaffected.
function recencyColor(color: string, activity: number, out = new THREE.Color()) {
  return out.set(color).lerp(RECENCY_FADE_COLOR, (1 - activity) * 0.72);
}

function activityIsVisible(id: string, historyActivity: HistoryActivity | null, activeHistoryFrame: HistoryFrame | null, historyRevealedNodeIds: Set<string>) {
  if (historyActivity === null || (historyActivity.values.get(id) ?? 0) <= 0) return false;
  return activeHistoryFrame === null || !activeHistoryFrame.changedNodeIds.has(id) || historyRevealedNodeIds.has(id);
}

function activityVisibilityKey(historyActivity: HistoryActivity | null, activeHistoryFrame: HistoryFrame | null, historyRevealedNodeIds: Set<string>, relevantIds: Set<string>) {
  const activeIds = Array.from(relevantIds)
    .filter(id => activityIsVisible(id, historyActivity, activeHistoryFrame, historyRevealedNodeIds))
    .join('\u0000');
  return activeIds;
}

function nodeIsVisible(node: CodeNode, visibleKinds: Set<CodeNode['kind']>, visibilityModes: NodeVisibilityModes, showExternal: boolean, showTestNamespaces: boolean, showGlobalNamespace: boolean, testNamespaces: ReadonlySet<string>, historyActivity: HistoryActivity | null, activeHistoryFrame: HistoryFrame | null, historyRevealedNodeIds: Set<string>) {
  if (!visibleKinds.has(node.kind) || (!showExternal && node.external) || (!showTestNamespaces && isTestNode(node, testNamespaces)) || (!showGlobalNamespace && isGlobalNode(node))) return false;
  if (node.kind === 'namespace' || visibilityModes[node.kind] === 'always') return true;
  return activityIsVisible(node.id, historyActivity, activeHistoryFrame, historyRevealedNodeIds);
}

function GroupOrigin({ group, selected, showLabel, opacity, activityPulse, heat, connection, connectionMode, fullOpacity, onSelect }: { group: LayoutGroup; selected: boolean; showLabel: boolean; opacity: number; activityPulse?: ActivityPulse; heat: number; connection: number; connectionMode: ConnectionMode; fullOpacity: boolean; onSelect: () => void }) {
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const textRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);
  const labelPulseStart = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const labelPulseKey = activityPulse?.id ?? '';
  const connectionColor = connectionMode === 'overdependency' ? '#ff5c68' : '#ffb347';
  const color = new THREE.Color(selected ? '#ffd166' : '#6d9bd1').lerp(new THREE.Color('#ff3d46'), heat).lerp(new THREE.Color(connectionColor), connection).getStyle();
  const label = group.activity ? group.label : `${displayNamespaceLabel(group.path)} / ${group.nodeCount} / ${group.global ? 'global owner' : 'inferred prefix'}`;
  useEffect(() => {
    if (!group.activity) return;
    labelPulseStart.current = null;
    labelRef.current?.scale.setScalar(activityPulse ? 4 : 1);
  }, [activityPulse, group.activity, labelPulseKey]);
  useFrame(({ clock }) => {
    const currentOpacity = fullOpacity || selected ? 1 : activityPulse ? activityGroupOpacity(activityPulse) : opacity;
    if (materialRef.current) materialRef.current.opacity = currentOpacity;
    const textMaterial = textRef.current?.material;
    if (textMaterial && !Array.isArray(textMaterial)) textMaterial.opacity = currentOpacity;
    if (!group.activity || !activityPulse || !labelRef.current) {
      labelRef.current?.scale.setScalar(1);
      return;
    }
    if (labelPulseStart.current === null) labelPulseStart.current = clock.elapsedTime;
    const elapsed = (clock.elapsedTime - labelPulseStart.current) * 1000;
    const fadeProgress = Math.max(0, Math.min(1, (elapsed - 3000) / 3000));
    const easedFade = fadeProgress * fadeProgress * (3 - 2 * fadeProgress);
    const scale = elapsed <= 3000 ? 4 : elapsed >= 6000 ? 1 : 4 - 3 * easedFade;
    labelRef.current.scale.setScalar(scale);
  });
  return (
    <group>
      <mesh
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
      >
        <octahedronGeometry args={[selected ? 0.9 : 0.62, 0]} />
        <meshBasicMaterial ref={materialRef} color={color} transparent opacity={fullOpacity || selected ? 1 : opacity} wireframe={selected} />
      </mesh>
      {(showLabel || hovered) && (
        <group ref={labelRef}>
          <Billboard position={[0, 1.05, 0]}>
            <Text ref={textRef} fontSize={0.42} color={color} fillOpacity={fullOpacity || selected ? 1 : opacity} outlineOpacity={fullOpacity || selected ? 1 : opacity} anchorX="center" anchorY="bottom" outlineWidth={0.016} outlineColor="#070b14">
              {label}
            </Text>
          </Billboard>
        </group>
      )}
    </group>
  );
}

export function activityTargetOpacity(pulse: ActivityPulse | undefined, now = Date.now()): number {
  if (!pulse) return ACTIVITY_TARGET_BASELINE_OPACITY;
  const elapsed = now - pulse.startedAt;
  // Failed pulses carry a longer reducer TTL (~2x); stretch the hold+fade window by the
  // same ratio so they fade proportionally slower instead of snapping to baseline at the
  // same wall-clock offset as every other kind.
  const defaultDuration = ACTIVITY_TARGET_HOLD_MS + ACTIVITY_TARGET_FADE_MS;
  const stretch = pulse.kind === 'failed' ? Math.max(1, (pulse.expiresAt - pulse.startedAt) / defaultDuration) : 1;
  const hold = ACTIVITY_TARGET_HOLD_MS * stretch;
  const fade = ACTIVITY_TARGET_FADE_MS * stretch;
  if (elapsed <= hold) return 1;
  if (elapsed >= hold + fade) return ACTIVITY_TARGET_BASELINE_OPACITY;
  const progress = Math.max(0, Math.min(1, (elapsed - hold) / fade));
  return 1 - progress * (1 - ACTIVITY_TARGET_BASELINE_OPACITY);
}

export const activityGroupOpacity = activityTargetOpacity;

function GroupActivity({ group, pulseKey, pulseColor, animation }: { group: LayoutGroup; pulseKey: string; pulseColor: string; animation: HierarchyAnimation }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const startTime = useRef<number | null>(null);
  useEffect(() => { startTime.current = null; }, [pulseKey]);
  useFrame(({ clock }) => {
    if (startTime.current === null) startTime.current = clock.elapsedTime;
    const progress = Math.min(1, (clock.elapsedTime - startTime.current) / 1.4);
    const size = animatedGroupSize(group, animation);
    meshRef.current?.scale.set(size[0] * (0.96 + progress * 0.3), size[1] * (0.96 + progress * 0.3), size[2] * (0.96 + progress * 0.3));
    if (materialRef.current) materialRef.current.opacity = (1 - progress) * 0.5;
  });
  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial ref={materialRef} color={pulseColor} transparent opacity={0.5} wireframe />
    </mesh>
  );
}

function GroupMotion({ groupRef, volumeRef, labelRef, group, active, activityMode, pulseKey, physics, animation }: {
  groupRef: RefObject<THREE.Group | null>;
  volumeRef: RefObject<THREE.Mesh | null>;
  labelRef: RefObject<THREE.Group | null>;
  group: LayoutGroup;
  active: boolean;
  activityMode: boolean;
  pulseKey: string;
  physics: PhysicsState | null;
  animation: HierarchyAnimation;
}) {
  const startTime = useRef<number | null>(null);
  useEffect(() => { startTime.current = null; }, [active, physics, pulseKey]);
  useFrame(({ clock }) => {
    const position = animatedGroupCenter(group, animation, physics);
    const size = animatedGroupSize(group, animation);
    groupRef.current?.position.set(position[0], position[1], position[2]);
    volumeRef.current?.scale.set(size[0], size[1], size[2]);
    if (group.activity?.kind === 'project') {
      labelRef.current?.position.set(-size[0] / 2 + 0.8, size[1] / 2 - 0.8, size[2] / 2 - 0.8);
    } else {
      labelRef.current?.position.set(0, size[1] / 2 + 0.45, 0);
    }
    if (!active || activityMode || !groupRef.current) {
      groupRef.current?.scale.setScalar(1);
      return;
    }
    if (startTime.current === null) startTime.current = clock.elapsedTime;
    const progress = Math.min(1, (clock.elapsedTime - startTime.current) / 0.5);
    groupRef.current.scale.setScalar(1.08 - progress * 0.08);
  });
  return null;
}

function HeatNamespaceLabel({ group, animation, opacity, activityPulse, fullOpacity }: { group: LayoutGroup; animation: HierarchyAnimation; opacity: number; activityPulse?: ActivityPulse; fullOpacity: boolean }) {
  const labelRef = useRef<THREE.Group>(null);
  const textRef = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const size = animatedGroupSize(group, animation);
    labelRef.current?.position.set(-size[0] / 2 + 0.12, size[1] / 2 + 0.08, size[2] / 2 + 0.02);
    const textMaterial = textRef.current?.material;
    if (textMaterial && !Array.isArray(textMaterial)) {
      textMaterial.opacity = fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : opacity;
    }
  });
  return (
    <group ref={labelRef}>
      <Billboard>
        <Text ref={textRef} fontSize={(group.depth === 0 ? 0.7 : 0.48) * 2} color="#ff3d46" fillOpacity={fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : opacity} outlineOpacity={fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : opacity} anchorX="left" anchorY="bottom" outlineWidth={0.022} outlineColor="#070b14" maxWidth={12}>
          {displayNamespaceLabel(group.actualNamespace ?? group.path)}
        </Text>
      </Billboard>
    </group>
  );
}

function GroupVolume({ group, selected, active, activityMode, pulseKey, pulseColor, activityPulse, physics, animation, historyActivity, showLeafDetails, showActivityLabel, heat, connection, connectionMode, fullOpacity, onSelect }: { group: LayoutGroup; selected: boolean; active: boolean; activityMode: boolean; pulseKey: string; pulseColor: string; activityPulse?: ActivityPulse; physics: PhysicsState | null; animation: HierarchyAnimation; historyActivity: HistoryActivity | null; showLeafDetails: boolean; showActivityLabel: boolean; heat: number; connection: number; connectionMode: ConnectionMode; fullOpacity: boolean; onSelect: () => void }) {
  const showGroupLabel = group.activity ? showActivityLabel : group.depth <= 1 || showLeafDetails;
  const topLevelActivityHierarchy = Boolean(group.activity
    && group.parentId === null
    && group.activity.kind !== 'bash'
    && group.activity.kind !== 'tool');
  const showOrigin = group.virtual && (group.depth <= 1 || showLeafDetails) && !topLevelActivityHierarchy;
  const testNamespace = isTestNamespaceName(group.actualNamespace);
  const groupLifetimeOpacity = group.activity?.lastActivityAt === undefined
    ? 1
    : (() => {
      const elapsed = Date.now() - group.activity.lastActivityAt;
      if (elapsed <= ACTIVITY_GROUP_RETENTION_MS) return 1;
      if (elapsed >= ACTIVITY_GROUP_RETENTION_MS + ACTIVITY_GROUP_FADE_MS) return 0;
      return 1 - (elapsed - ACTIVITY_GROUP_RETENTION_MS) / ACTIVITY_GROUP_FADE_MS;
    })();
  const groupActivity = activityMode
    ? Math.max(groupLifetimeOpacity, activityGroupOpacity(activityPulse))
    : group.namespaceNodeId ? activityValue(historyActivity, group.namespaceNodeId) : 1;
  const groupRef = useRef<THREE.Group>(null);
  const volumeRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<THREE.Group>(null);
  const labelTextRef = useRef<THREE.Mesh>(null);
  const initialPosition = animatedGroupCenter(group, animation, physics);
  const initialSize = animatedGroupSize(group, animation);
  useFrame(() => {
    const textMaterial = labelTextRef.current?.material;
    if (textMaterial && !Array.isArray(textMaterial)) {
      textMaterial.opacity = fullOpacity ? 1 : groupActivity;
    }
  });
  const geometryKind = groupGeometryKind(group.activity?.kind);
  const outcomeTint = activityGroupOutcomeColor(group.activity?.lastOutcome);
  return (
    <group ref={groupRef} position={initialPosition} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
      <mesh ref={volumeRef} scale={initialSize}>
        {geometryKind === 'sphere' ? <sphereGeometry args={[0.5, 24, 16]} /> : <boxGeometry args={[1, 1, 1]} />}
        {group.activity?.kind === 'web' ? (
          <meshStandardMaterial color="#4fd1ff" emissive="#4fd1ff" emissiveIntensity={0.22} transparent opacity={fullOpacity ? 0.16 : 0.1} depthWrite={false} roughness={0.6} />
        ) : group.activity?.kind === 'domain' ? (
          <meshStandardMaterial color={outcomeTint ?? '#7898ff'} emissive={outcomeTint ?? '#7898ff'} emissiveIntensity={0.4} transparent opacity={fullOpacity ? 1 : 0.55} roughness={0.4} />
        ) : outcomeTint ? (
          <meshStandardMaterial color={outcomeTint} emissive={outcomeTint} emissiveIntensity={0.4} transparent opacity={fullOpacity ? 1 : 0.55} roughness={0.4} />
        ) : (
          <meshBasicMaterial visible={false} />
        )}
      </mesh>
      <GroupMotion groupRef={groupRef} volumeRef={volumeRef} labelRef={labelRef} group={group} active={active} activityMode={activityMode} pulseKey={pulseKey} physics={physics} animation={animation} />
      {active && !activityMode && <GroupActivity key={pulseKey} group={group} pulseKey={pulseKey} pulseColor={pulseColor} animation={animation} />}
      {showOrigin && <GroupOrigin group={group} selected={selected} showLabel={showGroupLabel} opacity={groupActivity} activityPulse={activityPulse} heat={heat} connection={connection} connectionMode={connectionMode} fullOpacity={fullOpacity} onSelect={onSelect} />}
      {showGroupLabel && !showOrigin && (
        <group ref={labelRef} position={topLevelActivityHierarchy
          ? [-initialSize[0] / 2 + 0.8, initialSize[1] / 2 - 0.8, initialSize[2] / 2 - 0.8]
          : [0, initialSize[1] / 2 + 0.45, 0]}>
          <Billboard>
            <Text ref={labelTextRef} fontSize={topLevelActivityHierarchy ? 1.6 : group.depth === 0 ? 0.7 : 0.48} color={new THREE.Color(selected ? '#ffd166' : group.virtual ? '#6d9bd1' : testNamespace ? '#72acc6' : '#a9b7ff').lerp(new THREE.Color('#ff3d46'), heat).lerp(new THREE.Color(connectionMode === 'overdependency' ? '#ff5c68' : '#ffb347'), connection).getStyle()} fillOpacity={fullOpacity ? 1 : groupActivity} outlineOpacity={fullOpacity ? 1 : groupActivity} anchorX={topLevelActivityHierarchy ? 'left' : 'center'} anchorY={topLevelActivityHierarchy ? 'top' : 'bottom'} outlineWidth={0.018} outlineColor="#070b14" maxWidth={topLevelActivityHierarchy ? 48 : undefined}>
              {topLevelActivityHierarchy
                ? group.label
                : group.activity?.kind === 'domain'
                  ? domainGroupLabel(group.label, group.nodeCount)
                  : (group.activity ? group.label : displayNamespaceLabel(group.path)) + " / " + group.nodeCount}
            </Text>
          </Billboard>
        </group>
      )}
      {heat > 0 && <HeatNamespaceLabel group={group} animation={animation} opacity={groupActivity} activityPulse={activityPulse} fullOpacity={fullOpacity} />}
    </group>
  );
}
function CommitPulse({ radius, color, opacityScale = 1, onComplete }: { radius: number; color: string; opacityScale?: number; onComplete: () => void }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const startTime = useRef<number | null>(null);
  const completed = useRef(false);
  const uniforms = useMemo(() => ({
    uColor: { value: new THREE.Color(color) },
    uProgress: { value: 0 },
    uOpacity: { value: 0 },
  }), [color]);
  useFrame(({ clock }) => {
    if (startTime.current === null) startTime.current = clock.elapsedTime;
    const progress = Math.min(1, (clock.elapsedTime - startTime.current) / 1.25);
    if (materialRef.current) {
      materialRef.current.uniforms.uProgress.value = progress;
      materialRef.current.uniforms.uOpacity.value = (1 - progress) * 0.92 * opacityScale;
    }

    if (progress >= 1 && !completed.current) {
      completed.current = true;
      onComplete();
    }
  });
  return (
    <Billboard>
      <mesh>
        <planeGeometry args={[radius * 10, radius * 10]} />
        <shaderMaterial
          ref={materialRef}
          uniforms={uniforms}
          vertexShader={shockwaveVertexShader}
          fragmentShader={shockwaveFragmentShader}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </Billboard>
  );
}

function ActivityPulses({ pulses, positions, groups, nodeById, physics, animation, dimmedSessionIds }: { pulses: ActivityPulse[]; positions: GraphPositions; groups: LayoutGroup[]; nodeById: Map<string, CodeNode>; physics: PhysicsState | null; animation: HierarchyAnimation; dimmedSessionIds: ReadonlySet<string> }) {
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  return (
    <>
      {pulses.filter(pulse => pulse.target.kind === 'group' || nodeById.get(pulse.target.id)?.kind === 'keyword').map(pulse => {
        const group = pulse.target.kind === 'group' ? groupById.get(pulse.target.id) : undefined;
        const position = group
          ? animatedGroupCenter(group, animation, physics)
          : physics?.nodePositions.get(pulse.target.id) ?? positions.get(pulse.target.id);
        if (!position) return null;
        const radius = (group ? Math.max(...animatedGroupSize(group, animation)) * 0.08 : 0.48) * activityPulseSizeScale(pulse.kind);
        const opacityScale = activityDimFactor(pulse.sessionId, dimmedSessionIds);
        return <group key={pulse.id} position={position}><CommitPulse radius={radius} color={pulse.color} opacityScale={opacityScale} onComplete={() => undefined} /></group>;
      })}
    </>
  );
}

export function activityRayOpacity(ray: ActivityRay, now = Date.now()): number {
  const duration = Math.max(1, ray.expiresAt - ray.startedAt);
  return Math.max(0, 1 - Math.max(0, Math.min(1, (now - ray.startedAt) / duration)));
}

export function activityRayUsesDashPattern(ray: ActivityRay): boolean {
  return ray.target.kind === 'node' && ray.target.id.startsWith('agent:');
}

type ActivityRayAgentIdentity = Pick<ActivityAgentLayout, 'id' | 'agentId' | 'sessionId' | 'workspaceId'>;

export function activityRayWorkspaceCompatible(
  ray: ActivityRay,
  visibleAgents: readonly ActivityRayAgentIdentity[],
  allAgents: readonly ActivityRayAgentIdentity[] = visibleAgents,
): boolean {
  const targetWorkspaceId = ray.target.workspaceId;
  const link = ray.agentLink;
  const visibleSources = ray.sourceAgentNodeId
    ? visibleAgents.filter(agent => agent.id === ray.sourceAgentNodeId && agent.sessionId === ray.sessionId)
    : [];
  const knownSources = ray.sourceAgentNodeId
    ? allAgents.filter(agent => agent.id === ray.sourceAgentNodeId && agent.sessionId === ray.sessionId)
    : [];

  if (!link) {
    if (!targetWorkspaceId || ray.workspaceId === targetWorkspaceId) return true;
    return ray.workspaceId
      ? ray.workspaceId === targetWorkspaceId
      : !visibleSources.some(agent => agent.workspaceId !== undefined && agent.workspaceId !== targetWorkspaceId);
  }

  const targetIdIsNodeIdentity = link.targetAgentId.startsWith('agent:');
  const matchesTargetAgentId = (agent: ActivityRayAgentIdentity) => targetIdIsNodeIdentity
    ? agent.id === link.targetAgentId
    : agent.agentId === link.targetAgentId;
  const matchesSelectors = (agent: ActivityRayAgentIdentity) => matchesTargetAgentId(agent)
    && (!link.targetAgentNodeId || agent.id === link.targetAgentNodeId)
    && (!link.targetSessionId || agent.sessionId === link.targetSessionId)
    && (!link.targetWorkspaceId || agent.workspaceId === link.targetWorkspaceId);
  const allRecipientsByAgentId = allAgents.filter(matchesTargetAgentId);
  const allRecipientsMatchingSelectors = allRecipientsByAgentId.filter(matchesSelectors);
  const intendedRecipients = allRecipientsMatchingSelectors.length > 0 ? allRecipientsMatchingSelectors : allRecipientsByAgentId;
  const renderedRecipients = visibleAgents.filter(matchesSelectors);
  const rayTargetAgents = ray.target.kind === 'node' ? allAgents.filter(agent => agent.id === ray.target.id) : [];
  const sourceWorkspaceIds = [ray.workspaceId, ...knownSources.map(agent => agent.workspaceId)]
    .filter((workspaceId): workspaceId is string => Boolean(workspaceId));
  const targetWorkspaceIds = [
    targetWorkspaceId,
    link.targetWorkspaceId,
    ...intendedRecipients.map(agent => agent.workspaceId),
    ...rayTargetAgents.map(agent => agent.workspaceId),
  ].filter((workspaceId): workspaceId is string => Boolean(workspaceId));
  const crossesWorkspace = sourceWorkspaceIds.some(sourceWorkspace => targetWorkspaceIds.some(targetWorkspace => sourceWorkspace !== targetWorkspace));
  const selectorMismatch = allRecipientsByAgentId.length > 0 && allRecipientsMatchingSelectors.length === 0;

  if (!crossesWorkspace) {
    if (selectorMismatch) return false;
    return !ray.workspaceId || !targetWorkspaceId || ray.workspaceId === targetWorkspaceId;
  }
  if (!ray.sourceAgentNodeId || ray.target.kind !== 'node' || !activityRayUsesDashPattern(ray)) return false;
  if (visibleSources.length !== 1) return false;
  const source = visibleSources[0];
  if (!source.workspaceId || (ray.workspaceId && source.workspaceId !== ray.workspaceId)) return false;
  if (renderedRecipients.length !== 1) return false;
  const recipient = renderedRecipients[0];
  return Boolean(recipient.workspaceId
    && source.workspaceId !== recipient.workspaceId
    && recipient.id === ray.target.id);
}

export const MAX_ACTIVITY_FILE_LABELS = 12;

export function activityFileLabelIds(groups: LayoutGroup[], pulses: ActivityPulse[], selectedGroupId: string | null, showAll: boolean): Set<string> {
  const files = new Set(groups.filter(group => group.activity?.kind === 'file').map(group => group.id));
  if (showAll) return files;
  const visible = new Set<string>();
  if (selectedGroupId && files.has(selectedGroupId)) visible.add(selectedGroupId);
  const latestByGroup = new Map<string, ActivityPulse>();
  pulses.forEach(pulse => {
    if (pulse.target.kind !== 'group' || !files.has(pulse.target.id)) return;
    const previous = latestByGroup.get(pulse.target.id);
    if (!previous || pulse.startedAt > previous.startedAt) latestByGroup.set(pulse.target.id, pulse);
  });
  [...latestByGroup.values()]
    .sort((left, right) => right.startedAt - left.startedAt || left.target.id.localeCompare(right.target.id))
    .some(pulse => {
      visible.add(pulse.target.id);
      return visible.size >= MAX_ACTIVITY_FILE_LABELS;
    });
  return visible;
}

const ACTIVITY_RAY_DASH_SEGMENTS = 8;
const ACTIVITY_RAY_DASH_SPEED_PER_SECOND = 0.025;

export function activityRayDashFlowOffset(ray: ActivityRay, now = Date.now(), prefersReducedMotion = false): number {
  const flowDirection = ray.agentLink?.flowDirection;
  if (!flowDirection || prefersReducedMotion) return 0;
  const elapsedSeconds = Math.max(0, now - ray.startedAt) / 1000;
  return elapsedSeconds * ACTIVITY_RAY_DASH_SPEED_PER_SECOND
    * (flowDirection === 'source-to-target' ? 1 : -1);
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPrefersReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return prefersReducedMotion;
}

function ActivityRays({ rays, positions, groups, markers, physics, animation, dimmedSessionIds, visibleAgents, allAgents }: { rays: ActivityRay[]; positions: GraphPositions; groups: LayoutGroup[]; markers: ActivitySnippetMarkerData[]; physics: PhysicsState | null; animation: HierarchyAnimation; dimmedSessionIds: ReadonlySet<string>; visibleAgents: readonly ActivityRayAgentIdentity[]; allAgents: readonly ActivityRayAgentIdentity[] }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const markerById = useMemo(() => {
    const markersByGroup = new Map<string, ActivitySnippetMarkerData[]>();
    markers.forEach(marker => {
      const entries = markersByGroup.get(marker.groupId) ?? [];
      entries.push(marker);
      markersByGroup.set(marker.groupId, entries);
    });
    markersByGroup.forEach(entries => entries.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id)));
    const result = new Map<string, { marker: ActivitySnippetMarkerData; slot: number; total: number }>();
    markersByGroup.forEach(entries => entries.forEach((marker, slot) => result.set(marker.id, { marker, slot, total: entries.length })));
    return result;
  }, [markers]);
  const geometry = useMemo(() => {
    const nextGeometry = new THREE.BufferGeometry();
    const vertexCount = rays.length * ACTIVITY_RAY_DASH_SEGMENTS * 2;
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
    nextGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    return nextGeometry;
  }, [rays.length]);
  const object = useMemo(() => {
    const nextObject = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    nextObject.frustumCulled = false;
    return nextObject;
  }, [geometry]);
  // Reused every frame across every ray/segment instead of allocating a new
  // THREE.Color per ray (scratchRayColor) and per hidden dash segment
  // (scratchHiddenColor, which is always black and never mutated by callers).
  const scratchRayColor = useMemo(() => new THREE.Color(), []);
  const scratchHiddenColor = useMemo(() => new THREE.Color(0, 0, 0), []);
  const update = () => {
    const now = Date.now();
    const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    rays.forEach((ray, index) => {
      const sourceGroup = ray.sourceGroupId ? groupById.get(ray.sourceGroupId) : undefined;
      const targetGroup = ray.target.kind === 'group' ? groupById.get(ray.target.id) : undefined;
      const marker = ray.targetMarkerId ? markerById.get(ray.targetMarkerId) : undefined;
      const targetPosition = marker && targetGroup
        ? activitySnippetMarkerPosition(marker.marker, marker.slot, marker.total, targetGroup, physics, animation)
        : targetGroup
          ? animatedGroupCenter(targetGroup, animation, physics)
          : physics?.nodePositions.get(ray.target.id) ?? positions.get(ray.target.id);
      const sourcePosition = sourceGroup ? animatedGroupCenter(sourceGroup, animation, physics) : undefined;
      const agentPosition = ray.sourceAgentNodeId ? positions.get(ray.sourceAgentNodeId) : undefined;
      const resolvedSourcePosition = agentPosition ?? sourcePosition;
      const validTarget = activityRayWorkspaceCompatible(ray, visibleAgents, allAgents);
      const validSource = !ray.sourceId || !ray.target.sourceId || ray.sourceId === ray.target.sourceId;
      const visible = Boolean(resolvedSourcePosition && targetPosition && validTarget && validSource && (!ray.targetMarkerId || marker));
      const source = resolvedSourcePosition ?? [0, 0, 0];
      const target = visible ? targetPosition as [number, number, number] : source;
      const dashed = activityRayUsesDashPattern(ray);
      const animatedDashes = dashed && Boolean(ray.agentLink?.flowDirection);
      const dashOffset = animatedDashes ? activityRayDashFlowOffset(ray, now, prefersReducedMotion) : 0;
      const opacity = visible ? activityRayOpacity(ray, now) * activityDimFactor(ray.sessionId, dimmedSessionIds) : 0;
      const color = scratchRayColor.set(ray.color).multiplyScalar(opacity);
      const stride = index * ACTIVITY_RAY_DASH_SEGMENTS * 2;
      for (let segment = 0; segment < ACTIVITY_RAY_DASH_SEGMENTS; segment += 1) {
        let segmentStart = 0;
        let segmentEnd = segment === 0 && !dashed ? 1 : 0;
        let hidden = segment !== 0;
        if (dashed && !animatedDashes) {
          segmentStart = (segment + 0.08) / ACTIVITY_RAY_DASH_SEGMENTS;
          hidden = segment % 2 === 1;
          segmentEnd = hidden ? segmentStart : (segment + 0.62) / ACTIVITY_RAY_DASH_SEGMENTS;
        } else if (animatedDashes) {
          const dashIndex = Math.floor(segment / 2);
          const fragmentIndex = segment % 2;
          const rawStart = (dashIndex * 2 + 0.08) / ACTIVITY_RAY_DASH_SEGMENTS + dashOffset;
          const dashStart = ((rawStart % 1) + 1) % 1;
          const dashEnd = dashStart + 0.54 / ACTIVITY_RAY_DASH_SEGMENTS;
          if (dashEnd <= 1) {
            if (fragmentIndex === 0) {
              segmentStart = dashStart;
              segmentEnd = dashEnd;
              hidden = false;
            }
          } else if (fragmentIndex === 0) {
            segmentStart = dashStart;
            segmentEnd = 1;
            hidden = false;
          } else {
            segmentEnd = dashEnd - 1;
            hidden = false;
          }
        }
        const segmentColor = hidden ? scratchHiddenColor : color;
        const start: [number, number, number] = [
          source[0] + (target[0] - source[0]) * segmentStart,
          source[1] + (target[1] - source[1]) * segmentStart,
          source[2] + (target[2] - source[2]) * segmentStart,
        ];
        const end: [number, number, number] = [
          source[0] + (target[0] - source[0]) * segmentEnd,
          source[1] + (target[1] - source[1]) * segmentEnd,
          source[2] + (target[2] - source[2]) * segmentEnd,
        ];
        positionAttribute.setXYZ((stride + segment * 2), start[0], start[1], start[2]);
        positionAttribute.setXYZ((stride + segment * 2 + 1), end[0], end[1], end[2]);
        colorAttribute.setXYZ((stride + segment * 2), segmentColor.r, segmentColor.g, segmentColor.b);
        colorAttribute.setXYZ((stride + segment * 2 + 1), segmentColor.r, segmentColor.g, segmentColor.b);
      }
    });
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
  };
  useEffect(() => { update(); }, [allAgents, animation, dimmedSessionIds, geometry, groupById, markerById, physics, positions, prefersReducedMotion, rays, visibleAgents]);
  useFrame(() => { update(); });
  useEffect(() => () => { geometry.dispose(); (object.material as THREE.Material).dispose(); }, [geometry, object]);
  if (rays.length === 0) return null;
  return <primitive object={object} />;
}

export function activitySnippetMarkerOpacity(marker: ActivitySnippetMarkerData, now = Date.now()): number {
  if (now <= marker.startedAt + ACTIVITY_SNIPPET_MARKER_HOLD_MS) return 1;
  const progress = Math.max(0, Math.min(1, (now - marker.startedAt - ACTIVITY_SNIPPET_MARKER_HOLD_MS) / (ACTIVITY_SNIPPET_MARKER_TTL_MS - ACTIVITY_SNIPPET_MARKER_HOLD_MS)));
  const eased = progress * progress * (3 - 2 * progress);
  return 1 - eased;
}

export function activitySnippetMarkerScale(marker: ActivitySnippetMarkerData, now = Date.now()): number {
  if (now <= marker.startedAt + ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS) return ACTIVITY_SNIPPET_MARKER_MAX_SCALE;
  const progress = Math.max(0, Math.min(1,
    (now - marker.startedAt - ACTIVITY_SNIPPET_MARKER_SCALE_HOLD_MS) / ACTIVITY_SNIPPET_MARKER_SCALE_FADE_MS));
  const eased = progress * progress * (3 - 2 * progress);
  return ACTIVITY_SNIPPET_MARKER_MAX_SCALE
    - (ACTIVITY_SNIPPET_MARKER_MAX_SCALE - 1) * eased;
}

function activitySnippetMarkerPosition(marker: ActivitySnippetMarkerData, slot: number, total: number, group: LayoutGroup, physics: PhysicsState | null, animation: HierarchyAnimation): [number, number, number] {
  const position = animatedGroupCenter(group, animation, physics);
  const size = animatedGroupSize(group, animation);
  const count = Math.max(1, total);
  const fraction = count === 1 ? 0.5 : (slot + 0.5) / count;
  const y = 1 - fraction * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = slot * Math.PI * (3 - Math.sqrt(5));
  return [
    position[0] + Math.cos(angle) * radius * size[0] * 0.34,
    position[1] + y * size[1] * 0.32,
    position[2] + Math.sin(angle) * radius * size[2] * 0.34,
  ];
}

function ActivitySnippetMarker({ marker, slot, total, group, physics, animation, dimmedSessionIds }: { marker: ActivitySnippetMarkerData; slot: number; total: number; group: LayoutGroup; physics: PhysicsState | null; animation: HierarchyAnimation; dimmedSessionIds: ReadonlySet<string> }) {
  const groupRef = useRef<THREE.Group>(null);
  const markerRef = useRef<THREE.Mesh>(null);
  const textRef = useRef<THREE.Mesh>(null);
  useFrame(() => {
    groupRef.current?.position.set(...activitySnippetMarkerPosition(marker, slot, total, group, physics, animation));
    const opacity = activitySnippetMarkerOpacity(marker) * activityDimFactor(marker.sessionId, dimmedSessionIds);
    const material = markerRef.current?.material;
    if (material && !Array.isArray(material)) {
      material.opacity = opacity;
    }
    const textMaterial = textRef.current?.material;
    if (textMaterial && !Array.isArray(textMaterial)) {
      textMaterial.opacity = opacity;
    }
    textRef.current?.scale.setScalar(activitySnippetMarkerScale(marker));
  });
  return (
    <group ref={groupRef}>
      <mesh ref={markerRef}>
        <octahedronGeometry args={[0.68, 0]} />
        <meshBasicMaterial color="#d6e3ff" transparent opacity={1} wireframe />
      </mesh>
      <Billboard position={[0, 0.86, 0]}>
        <Text ref={textRef} fontSize={0.22} color="#d6e3ff" fillOpacity={1} outlineOpacity={1} anchorX="center" anchorY="bottom" outlineWidth={0.012} outlineColor="#070b14" maxWidth={12}>
          {marker.text}
        </Text>
      </Billboard>
    </group>
  );
}

function ActivitySnippetMarkers({ markers, groups, physics, animation, dimmedSessionIds }: { markers: ActivitySnippetMarkerData[]; groups: LayoutGroup[]; physics: PhysicsState | null; animation: HierarchyAnimation; dimmedSessionIds: ReadonlySet<string> }) {
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const markersByGroup = useMemo(() => {
    const grouped = new Map<string, ActivitySnippetMarkerData[]>();
    markers.forEach(marker => {
      const entries = grouped.get(marker.groupId) ?? [];
      entries.push(marker);
      grouped.set(marker.groupId, entries);
    });
    grouped.forEach(entries => entries.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id)));
    return grouped;
  }, [markers]);
  return (
    <>
      {[...markersByGroup.entries()].flatMap(([groupId, groupMarkers]) => groupMarkers.map((marker, slot) => {
        const group = groupById.get(groupId);
        if (!group?.activity) return null;
        return <ActivitySnippetMarker key={marker.id} marker={marker} slot={slot} total={groupMarkers.length} group={group} physics={physics} animation={animation} dimmedSessionIds={dimmedSessionIds} />;
      }))}
    </>
  );
}

const keywordPulseVertexShader = [
  'attribute float aProgress;',
  'attribute float aSize;',
  'varying float vProgress;',
  'varying vec2 vUv;',
  'void main() {',
  '  vProgress = aProgress;',
  '  vUv = uv;',
  '  float active = step(0.0, aProgress) * step(aProgress, 1.0);',
  '  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
  '  vec2 offset = position.xy * aSize * active;',
  '  gl_Position = projectionMatrix * (center + vec4(offset, 0.0, 0.0));',
  '}',
].join(String.fromCharCode(10));

const keywordPulseFragmentShader = [
  'uniform vec3 uColor;',
  'varying float vProgress;',
  'varying vec2 vUv;',
  'void main() {',
  '  float distanceFromCenter = length(vUv - vec2(0.5)) * 2.0;',
  '  float ringRadius = 0.04 + vProgress * 0.88;',
  '  float ringWidth = 0.055 + (1.0 - vProgress) * 0.035;',
  '  float ringDistance = abs(distanceFromCenter - ringRadius);',
  '  float ring = 1.0 - smoothstep(ringWidth, ringWidth * 2.0, ringDistance);',
  '  float halo = 1.0 - smoothstep(ringWidth * 2.0, ringWidth * 7.0, ringDistance);',
  '  float circle = 1.0 - smoothstep(0.88, 1.0, distanceFromCenter);',
  '  float alpha = (ring * 0.9 + halo * 0.22) * circle;',
  '  if (alpha < 0.001) discard;',
  '  gl_FragColor = vec4(uColor, alpha);',
  '}',
].join(String.fromCharCode(10));

function KeywordCloud({ nodes, positions, physics, nodeSizeFactors, nodeScale, selectedId, dimmedIds, onSelect, onFocus, historyActivity, activityPulseByNodeId, fullOpacity }: {
  nodes: CodeNode[];
  positions: GraphPositions;
  physics: PhysicsState | null;
  nodeSizeFactors: Map<string, number>;
  nodeScale: number;
  selectedId: string | null;
  dimmedIds: Set<string>;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  historyActivity: HistoryActivity | null;
  activityPulseByNodeId: Map<string, ActivityPulse>;
  fullOpacity: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const selectedRef = useRef<THREE.Group>(null);
  const selectedTextRef = useRef<THREE.Mesh>(null);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const rotation = useMemo(() => new THREE.Quaternion(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);
  const point = useMemo(() => new THREE.Vector3(), []);
  const selectedNode = selectedId ? nodes.find(node => node.id === selectedId) : undefined;
  const selectedPosition = selectedNode ? physics?.nodePositions.get(selectedNode.id) ?? positions.get(selectedNode.id) : undefined;
  const selectedActivityPulse = selectedNode ? activityPulseByNodeId.get(selectedNode.id) : undefined;
  const selectedLabelOpacity = fullOpacity ? 1 : selectedActivityPulse ? activityTargetOpacity(selectedActivityPulse) : selectedNode ? Math.min(dimmedIds.has(selectedNode.id) ? 0.13 : selectedNode.external ? 0.52 : 1, 0.08 + activityValue(historyActivity, selectedNode.id) * 0.92) : 1;
  const geometry = useMemo(() => new THREE.SphereGeometry(0.24, 6, 4), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1 }), []);
  const updateInstances = () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const color = new THREE.Color();
    nodes.forEach((node, index) => {
      const position = physics?.nodePositions.get(node.id) ?? positions.get(node.id);
      if (!position) return;
      const factor = nodeSizeFactors.get(node.id) ?? 1;
      scale.set(nodeScale * factor, nodeScale * factor, nodeScale * factor);
      point.set(position[0], position[1], position[2]);
      matrix.compose(point, rotation, scale);
      mesh.setMatrixAt(index, matrix);
      const activity = activityValue(historyActivity, node.id);
      const activityPulse = activityPulseByNodeId.get(node.id);
      if (node.id === selectedId) color.set('#ffffff');
      else {
        recencyColor(dimmedIds.has(node.id) ? '#29314e' : '#df8eff', activity, color);
      }
      color.multiplyScalar(fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : node.id === selectedId ? 0.9 : (0.18 + activity * 0.82) * 0.9);
      mesh.setColorAt(index, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  useEffect(() => {
    meshRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    updateInstances();
  }, [nodes, positions, physics, nodeSizeFactors, nodeScale, selectedId, dimmedIds, historyActivity, activityPulseByNodeId, fullOpacity]);
  useFrame(() => {
    if (physics || activityPulseByNodeId.size > 0) updateInstances();
    const position = selectedNode ? physics?.nodePositions.get(selectedNode.id) ?? positions.get(selectedNode.id) : undefined;
    if (position) selectedRef.current?.position.set(position[0], position[1], position[2]);
    const selectedTextMaterial = selectedTextRef.current?.material;
    if (selectedTextMaterial && !Array.isArray(selectedTextMaterial)) selectedTextMaterial.opacity = fullOpacity || !selectedActivityPulse ? selectedLabelOpacity : activityTargetOpacity(selectedActivityPulse);
  });
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  return (
    <>
      <instancedMesh ref={meshRef} args={[geometry, material, nodes.length]} frustumCulled={false}
        onClick={(event) => {
          event.stopPropagation();
          const node = event.instanceId === undefined ? undefined : nodes[event.instanceId];
          if (node) onSelect(node.id);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          const node = event.instanceId === undefined ? undefined : nodes[event.instanceId];
          if (node) onFocus(node.id);
        }}
      />
      {selectedNode && selectedPosition && (
        <group ref={selectedRef} position={selectedPosition}>
          <Billboard position={[0, 0.55, 0]}>
            <Text ref={selectedTextRef} fontSize={0.27} color="#ffffff" fillOpacity={selectedLabelOpacity} outlineOpacity={selectedLabelOpacity} anchorX="center" anchorY="bottom" outlineWidth={0.012} outlineColor="#070b14" maxWidth={4}>
              {displayLabel(selectedNode)}
            </Text>
          </Billboard>
        </group>
      )}
    </>
  );
}

function KeywordPulseCloud({ nodes, positions, physics, nodeSizeFactors, nodeScale, revealedNodeIds, historyNodeOrder, historyElapsed, historyStepMs }: {
  nodes: CodeNode[];
  positions: GraphPositions;
  physics: PhysicsState | null;
  nodeSizeFactors: Map<string, number>;
  nodeScale: number;
  revealedNodeIds: Set<string>;
  historyNodeOrder: string[];
  historyElapsed: number;
  historyStepMs: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const progress = useMemo(() => new Float32Array(nodes.length), [nodes.length]);
  const sizes = useMemo(() => new Float32Array(nodes.length), [nodes.length]);
  const orderIndex = useMemo(() => new Map(historyNodeOrder.map((id, index) => [id, index])), [historyNodeOrder]);
  const geometry = useMemo(() => {
    const nextGeometry = new THREE.PlaneGeometry(1, 1);
    nextGeometry.setAttribute('aProgress', new THREE.InstancedBufferAttribute(progress, 1));
    nextGeometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 1));
    return nextGeometry;
  }, [progress, sizes]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#e69bff') } },
    vertexShader: keywordPulseVertexShader,
    fragmentShader: keywordPulseFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  }), []);
  const object = useMemo(() => {
    const nextObject = new THREE.InstancedMesh(geometry, material, nodes.length);
    nextObject.visible = false;
    nextObject.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nextObject.frustumCulled = false;
    return nextObject;
  }, [geometry, material, nodes.length]);
  const keywordIds = useMemo(() => new Set(nodes.map(node => node.id)), [nodes]);
  const hasKeywordChanges = historyNodeOrder.some(id => keywordIds.has(id));
  useFrame(() => {
    object.visible = hasKeywordChanges;
    if (!hasKeywordChanges) return;
    nodes.forEach((node, index) => {
      const position = physics?.nodePositions.get(node.id) ?? positions.get(node.id);
      const nodeOrder = orderIndex.get(node.id);
      const nodeProgress = nodeOrder !== undefined && revealedNodeIds.has(node.id)
        ? (historyElapsed - nodeOrder * historyStepMs) / 1250
        : -1;
      progress[index] = nodeProgress;
      const factor = nodeSizeFactors.get(node.id) ?? 1;
      sizes[index] = 0.24 * nodeScale * factor * 1.25 * 10;
      if (position) matrix.makeTranslation(position[0], position[1], position[2]);
      object.setMatrixAt(index, matrix);
    });
    (geometry.getAttribute('aProgress') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aSize') as THREE.InstancedBufferAttribute).needsUpdate = true;
    object.instanceMatrix.needsUpdate = true;
  });
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);
  return <primitive object={object} />;
}

function GraphNode({ node, position, selected, dimmed, showLabel, scale, sizeFactor, changed, newNamespace, activity, heat, connection, connectionMode, fullOpacity, pulseKey, activityPulse, onSelect, onFocus, physics, displayLabel }: {
  node: CodeNode;
  position: [number, number, number];
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  scale: number;
  sizeFactor: number;
  changed: boolean;
  newNamespace: boolean;
  activity: number;
  heat: number;
  connection: number;
  connectionMode: ConnectionMode;
  fullOpacity: boolean;
  pulseKey: string;
  activityPulse?: ActivityPulse;
  onSelect: () => void;
  onFocus: () => void;
  physics: PhysicsState | null;
  displayLabel?: string;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const textRef = useRef<THREE.Mesh>(null);
  const labelPulseRef = useRef<THREE.Group>(null);
  const labelPulseStart = useRef<number | null>(null);
  const labelPulseKey = useRef('');
  const completedPulseKey = useRef('');
  const pulseInstanceKey = useRef('');
  const [pulseVisible, setPulseVisible] = useState(false);
  const [pulseColor, setPulseColor] = useState('#ffffff');
  const testNamespace = isTestNode(node);
  const pulseColorForNode = activityPulse?.color ?? (changed && newNamespace ? '#ffd166' : nodePulseColor(node.kind, testNamespace));
  useEffect(() => {
    if (pulseKey && pulseKey !== labelPulseKey.current) {
      labelPulseKey.current = pulseKey;
      completedPulseKey.current = '';
      labelPulseStart.current = null;
    }
  }, [pulseKey]);
  useEffect(() => {
    if (!pulseKey || pulseKey === pulseInstanceKey.current) return;
    pulseInstanceKey.current = pulseKey;
    setPulseColor(pulseColorForNode);
    setPulseVisible(true);
  }, [pulseKey, pulseColorForNode]);
  useFrame(({ clock }) => {
    const physicsPosition = physics?.nodePositions.get(node.id);
    if (physicsPosition) groupRef.current?.position.set(...physicsPosition);
    const currentOpacity = fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : opacity;
    if (materialRef.current) materialRef.current.opacity = currentOpacity;
    const textMaterial = textRef.current?.material;
    if (textMaterial && !Array.isArray(textMaterial)) textMaterial.opacity = currentOpacity;
    if (labelPulseKey.current && labelPulseStart.current === null && completedPulseKey.current !== labelPulseKey.current) {
      labelPulseStart.current = clock.elapsedTime;
    }
    if (labelPulseStart.current === null) {
      labelPulseRef.current?.scale.setScalar(1);
      return;
    }
    const elapsed = (clock.elapsedTime - labelPulseStart.current) * 1000;
    if (elapsed >= 10000) {
      labelPulseRef.current?.scale.setScalar(1);
      completedPulseKey.current = labelPulseKey.current;
      labelPulseStart.current = null;
      return;
    }
    const peakScale = node.kind === 'namespace' ? 5 : 4;
    const labelScale = elapsed <= 3000 ? peakScale : peakScale - (peakScale - 1) * ((elapsed - 3000) / 7000);
    labelPulseRef.current?.scale.setScalar(labelScale);
  });
  const [hovered, setHovered] = useState(false);
  const radius = (node.kind === 'namespace' ? 0.78 : node.kind === 'var' ? 0.38 : 0.26) * scale * sizeFactor;
  const color = nodeColor(node.kind, node.external, testNamespace);
  const isNewNamespace = changed && newNamespace;
  const displayColor = isNewNamespace ? '#ffd166' : color;
  const activityColor = recencyColor(displayColor, activity);
  const heatedColor = activityColor.lerp(new THREE.Color('#ff3d46'), heat);
  const connectedColor = heatedColor.lerp(new THREE.Color(connectionMode === 'overdependency' ? '#ff5c68' : '#ffb347'), connection);
  const opacity = fullOpacity ? 1 : activityPulse ? activityTargetOpacity(activityPulse) : Math.min(dimmed ? 0.13 : node.external ? 0.52 : 1, 0.08 + activity * 0.92);
  return (
    <group ref={groupRef} position={position}>
      <mesh
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
        onDoubleClick={(event) => { event.stopPropagation(); onFocus(); }}
        onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
        scale={hovered || selected ? 1.18 : 1}
      >
        <sphereGeometry args={[radius, node.kind === 'namespace' ? 20 : 12, node.kind === 'namespace' ? 20 : 12]} />
        <meshStandardMaterial ref={materialRef} color={selected ? '#ffffff' : connectedColor.getStyle()} emissive={connectedColor.getStyle()} emissiveIntensity={selected ? 0.8 : (changed ? 0.9 : hovered ? 0.38 : 0.12) * (0.35 + activity * 0.65) + heat * 1.2 + connection * 1.1} transparent opacity={opacity} roughness={0.34} />
      </mesh>
      {pulseVisible && <CommitPulse key={pulseInstanceKey.current} radius={radius * 1.25} color={pulseColor} onComplete={() => setPulseVisible(false)} />}
      {selected && <mesh scale={1.45}>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={fullOpacity ? 1 : 0.72} />
      </mesh>}
      {showLabel && !dimmed && (
        <group ref={labelPulseRef}>
          <Billboard position={[0, radius + 0.28, 0]}>
            <Text ref={textRef} fontSize={node.kind === 'namespace' ? 0.42 : 0.27} color={selected ? '#ffffff' : node.kind === 'namespace' && connection > 0 ? connectedColor.getStyle() : node.kind === 'namespace' ? (testNamespace ? '#72acc6' : '#78a6ff') : node.kind === 'var' ? '#b8d8cc' : '#b8c7e8'} fontWeight={node.kind === 'namespace' ? 700 : 400} fillOpacity={opacity} outlineOpacity={opacity} anchorX="center" anchorY="bottom" outlineWidth={0.012} outlineColor="#070b14" maxWidth={node.kind === 'namespace' ? 7 : 4}>
              {displayLabel ?? node.label}
            </Text>
          </Billboard>
        </group>
      )}
      {hovered && !selected && (
        <Html center distanceFactor={18} style={{ pointerEvents: 'none' }}>
          <div className="scene-tooltip"><strong>{node.label}</strong><span>{node.kind}{node.external ? ' / external' : ''}</span></div>
        </Html>
      )}
    </group>
  );
}

export const ACTIVITY_AGENT_DEFAULT_FACING = Math.PI;

export function activityAgentFacingAngle(position: [number, number, number], targetPosition?: [number, number, number]): number {
  if (!targetPosition) return ACTIVITY_AGENT_DEFAULT_FACING;
  const x = targetPosition[0] - position[0];
  const z = targetPosition[2] - position[2];
  return Math.hypot(x, z) < 0.001 ? ACTIVITY_AGENT_DEFAULT_FACING : Math.atan2(x, z);
}

export function activityAgentShortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function activityAgentStatusBaseline(status: string): number {
  const normalized = status.toLowerCase();
  if (normalized === 'failed' || normalized === 'error') return 0.5;
  if (normalized === 'stopped' || normalized === 'completed' || normalized === 'complete' || normalized === 'idle') return 0.3;
  return 0.82;
}

export function activityAgentOpacity(agent: ActivityAgentLayout, now = Date.now(), activityAt = agent.updatedAt, inactive = false): number {
  const baseline = inactive ? 0.3 : activityAgentStatusBaseline(agent.status);
  if (inactive) return baseline;
  const age = Math.max(0, now - activityAt);
  if (age <= ACTIVITY_TARGET_HOLD_MS) return 1;
  const progress = Math.max(0, Math.min(1, (age - ACTIVITY_TARGET_HOLD_MS) / ACTIVITY_TARGET_FADE_MS));
  const eased = progress * progress * (3 - 2 * progress);
  return baseline + (1 - baseline) * (1 - eased);
}

function ActivityInactiveGridLabel({ agents }: { agents: ActivityAgentLayout[] }) {
  if (agents.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const agent of agents) {
    minX = Math.min(minX, agent.center[0]);
    maxX = Math.max(maxX, agent.center[0]);
    minZ = Math.min(minZ, agent.center[2]);
    maxZ = Math.max(maxZ, agent.center[2]);
  }
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    agents[0].center[1],
    (minZ + maxZ) / 2,
  ];
  return (
    <Billboard position={[center[0], center[1] + 15, center[2]]}>
      <Text fontSize={0.42} color="#8a94a8" fillOpacity={0.82} outlineOpacity={0.82} anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor="#070b14">
        inactive agents
      </Text>
    </Billboard>
  );
}

function compactActivityIdentifier(value: string): string {
  if (value.length <= 28) return value;
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}·${(hash >>> 0).toString(16).slice(-6)}`;
}

function ActivityAgentGlyph({ agent, position, targetPosition, targetExpiresAt, activityAt, inactive, identityLabel, dimmedSessionIds, onSelect }: { agent: ActivityAgentLayout; position: [number, number, number]; targetPosition?: [number, number, number]; targetExpiresAt?: number; activityAt?: number; inactive?: boolean; identityLabel?: string; dimmedSessionIds: ReadonlySet<string>; onSelect: () => void }) {
  const groupRef = useRef<THREE.Group>(null);
  const haloMeshRef = useRef<THREE.Mesh>(null);
  const haloMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const initialPositionRef = useRef(position);
  const targetAngleRef = useRef(ACTIVITY_AGENT_DEFAULT_FACING);
  const startAngleRef = useRef(ACTIVITY_AGENT_DEFAULT_FACING);
  const angleDeltaRef = useRef(0);
  const transitionElapsedRef = useRef(1 / 3);
  const status = agent.status.toLowerCase();
  const failed = status === 'failed' || status === 'error';
  const subdued = status === 'stopped' || status === 'completed' || status === 'complete' || status === 'idle';
  const color = new THREE.Color(agent.color);
  const displayColor = inactive
    ? color.lerp(new THREE.Color('#7f899e'), 0.8)
    : failed
      ? color.lerp(new THREE.Color('#ff5c68'), 0.56)
      : subdued
        ? color.lerp(new THREE.Color('#7f899e'), 0.72)
        : color;
  const dimFactor = activityDimFactor(agent.sessionId, dimmedSessionIds);
  const appearance = agentGlyphAppearance(agent, Date.now());
  const opacity = activityAgentOpacity(agent, Date.now(), activityAt, inactive) * dimFactor;
  const material = {
    color: displayColor.getStyle(),
    emissive: displayColor.getStyle(),
    emissiveIntensity: failed ? 0.2 : subdued ? 0.05 : 0.5,
    transparent: true,
    opacity,
    roughness: 0.3,
  };
  useFrame(({ clock }, delta) => {
    const group = groupRef.current;
    if (!group) return;
    const frameDelta = Math.max(0, delta);
    group.position.set(
      THREE.MathUtils.damp(group.position.x, position[0], 4.5, frameDelta),
      THREE.MathUtils.damp(group.position.y, position[1], 4.5, frameDelta),
      THREE.MathUtils.damp(group.position.z, position[2], 4.5, frameDelta),
    );
    const liveOpacity = activityAgentOpacity(agent, Date.now(), activityAt, inactive) * dimFactor;
    group.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      if (Array.isArray(child.material)) {
        child.material.forEach(material => {
          if ('opacity' in material) material.opacity = liveOpacity;
        });
      } else if ('opacity' in child.material) {
        child.material.opacity = liveOpacity;
      }
    });
    // Halo ring: overrides the blanket opacity the traverse loop above just applied,
    // since its own fade/pulse dynamics differ from the body's per state (T1-B).
    const liveAppearance = agentGlyphAppearance(agent, Date.now());
    if (haloMeshRef.current && haloMaterialRef.current) {
      if (liveAppearance.halo === null) {
        haloMeshRef.current.visible = false;
      } else {
        haloMeshRef.current.visible = true;
        haloMaterialRef.current.color.set(liveAppearance.color);
        const ringOpacity = liveAppearance.halo === 'waiting'
          ? 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 3.6))
          : liveAppearance.halo === 'denied'
            ? Math.max(0, 0.9 * (1 - (Date.now() - (agent.lastDeniedAt ?? 0)) / ACTIVITY_AGENT_DENIED_FLASH_MS))
            : 0.28;
        haloMaterialRef.current.opacity = ringOpacity * liveOpacity;
      }
    }
    const validTarget = targetPosition !== undefined
      && (targetExpiresAt === undefined || targetExpiresAt > Date.now());
    const livePosition: [number, number, number] = [group.position.x, group.position.y, group.position.z];
    const targetAngle = validTarget ? activityAgentFacingAngle(livePosition, targetPosition) : ACTIVITY_AGENT_DEFAULT_FACING;
    if (Math.abs(activityAgentShortestAngle(targetAngleRef.current, targetAngle)) > 0.0001) {
      targetAngleRef.current = targetAngle;
      startAngleRef.current = group.rotation.y;
      angleDeltaRef.current = activityAgentShortestAngle(startAngleRef.current, targetAngle);
      transitionElapsedRef.current = 0;
    }
    if (transitionElapsedRef.current < 1 / 3) {
      transitionElapsedRef.current = Math.min(1 / 3, transitionElapsedRef.current + frameDelta);
      const progress = transitionElapsedRef.current / (1 / 3);
      const eased = progress * progress * (3 - 2 * progress);
      group.rotation.y = startAngleRef.current + angleDeltaRef.current * eased;
      return;
    }
    group.rotation.y = targetAngleRef.current;
  });
  return (
    <group ref={groupRef} position={initialPositionRef.current} rotation={[0, ACTIVITY_AGENT_DEFAULT_FACING, 0]} scale={ACTIVITY_AGENT_GLYPH_SCALE} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
      <mesh ref={haloMeshRef} position={[0, -0.45, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5} visible={appearance.halo !== null}>
        <ringGeometry args={[1.85, 2.35, 32]} />
        <meshBasicMaterial ref={haloMaterialRef} color={appearance.color} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[2.6, 1.8, 1.7]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <mesh position={[0, 1.55, 0]}>
        <boxGeometry args={[2.05, 1.2, 1.45]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <mesh position={[-0.52, 1.58, 0.74]}>
        <boxGeometry args={[0.28, 0.28, 0.08]} />
        <meshBasicMaterial color="#070b14" transparent opacity={opacity} />
      </mesh>
      <mesh position={[0.52, 1.58, 0.74]}>
        <boxGeometry args={[0.28, 0.28, 0.08]} />
        <meshBasicMaterial color="#070b14" transparent opacity={opacity} />
      </mesh>
      <mesh position={[0, 2.45, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.55, 8]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <mesh position={[0, 2.78, 0]}>
        <sphereGeometry args={[0.18, 8, 8]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <mesh position={[-1.55, 0.2, 0]}>
        <boxGeometry args={[0.35, 1.2, 0.45]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <mesh position={[1.55, 0.2, 0]}>
        <boxGeometry args={[0.35, 1.2, 0.45]} />
        <meshStandardMaterial {...material} />
      </mesh>
      <Billboard position={[0, 3.5, 0]}>
        <Text fontSize={0.96} color={displayColor.getStyle()} fillOpacity={opacity} outlineOpacity={opacity} anchorX="center" anchorY="bottom" outlineWidth={0.018} outlineColor="#070b14" maxWidth={12}>
          {agent.label}{appearance.halo === 'waiting' ? ' · waiting' : ''}
        </Text>
        <Text position={[0, -0.82, 0]} fontSize={0.22} color="#8f9fbe" fillOpacity={opacity} outlineOpacity={opacity} anchorX="center" anchorY="top" outlineWidth={0.01} outlineColor="#070b14" maxWidth={14}>
          {identityLabel ?? `agent · ${compactActivityIdentifier(agent.agentId)}`}
        </Text>
        <Text position={[0, -1.2, 0]} fontSize={0.28} color="#b8c7e8" fillOpacity={opacity} outlineOpacity={opacity} anchorX="center" anchorY="top" outlineWidth={0.012} outlineColor="#070b14" maxWidth={14}>
          {`${agent.status} · ${agent.activity}`}
        </Text>
      </Billboard>
    </group>
  );
}

function PhysicsSimulation({ state, graph, groups, edges }: { state: PhysicsState | null; graph: CodeGraph; groups: LayoutGroup[]; edges: CodeEdge[] }) {
  useFrame((_, delta) => {
    if (state) stepPhysics(state, graph, groups, edges, delta);
  });
  return null;
}

function PhysicsEdges({ edges, state, selectedId, activeHistoryFrame, historyActivity, relationshipVisibilityMode, fullOpacity }: { edges: CodeEdge[]; state: PhysicsState; selectedId: string | null; activeHistoryFrame: HistoryFrame | null; historyActivity: HistoryActivity | null; relationshipVisibilityMode: NodeVisibilityMode; fullOpacity: boolean }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(edges.length * 6);
    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    nextGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(edges.length * 6), 3));
    return nextGeometry;
  }, [edges]);
  const updateColors = () => {
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    const color = new THREE.Color();
    edges.forEach((edge, index) => {
      const changed = relationshipChanged(edge, activeHistoryFrame);
      const active = selectedId === edge.source || selectedId === edge.target;
      const fade = relationshipVisibilityMode === 'updated' ? relationshipActivity(edge, historyActivity) : 1;
      color.set(edge.kind === 'requires' ? '#6f8cff' : edge.kind === 'calls' ? '#47d7b0' : '#e2a0ff');
      color.multiplyScalar(fullOpacity ? 1 : fade * (changed || active ? 1 : 0.3));
      for (let vertex = 0; vertex < 2; vertex += 1) {
        attribute.setXYZ(index * 2 + vertex, color.r, color.g, color.b);
      }
    });
    attribute.needsUpdate = true;
  };
  useEffect(() => { updateColors(); }, [activeHistoryFrame, edges, fullOpacity, geometry, historyActivity, relationshipVisibilityMode, selectedId]);
  const object = useMemo(() => {
    const nextObject = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: fullOpacity ? 1 : 0.6 }));
    nextObject.frustumCulled = false;
    return nextObject;
  }, [fullOpacity, geometry]);
  useFrame(() => {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    edges.forEach((edge, index) => {
      const source = state.nodePositions.get(edge.source);
      const target = state.nodePositions.get(edge.target);
      if (!source || !target) return;
      attribute.setXYZ(index * 2, source[0], source[1], source[2]);
      attribute.setXYZ(index * 2 + 1, target[0], target[1], target[2]);
    });
    attribute.needsUpdate = true;
  });
  useEffect(() => () => { geometry.dispose(); (object.material as THREE.Material).dispose(); }, [geometry, object]);
  return <primitive object={object} />;
}

interface HierarchySegment {
  group: LayoutGroup;
  startGroup: LayoutGroup;
  endGroup: LayoutGroup;
  start: [number, number, number];
  end: [number, number, number];
}

interface AnimatedHierarchyGroup {
  currentCenter: THREE.Vector3;
  currentSize: THREE.Vector3;
  startCenter: THREE.Vector3;
  startSize: THREE.Vector3;
  targetCenter: THREE.Vector3;
  targetSize: THREE.Vector3;
  animating: boolean;
  startTime: number | null;
}

interface HierarchyAnimation {
  entries: Map<string, AnimatedHierarchyGroup>;
  initialized: boolean;
}

const HIERARCHY_TRANSITION_SECONDS = 0.9;

function useHierarchyAnimation(groups: LayoutGroup[]): HierarchyAnimation {
  const stateRef = useRef<HierarchyAnimation>({ entries: new Map(), initialized: false });
  const state = stateRef.current;
  const groupIds = new Set(groups.map(group => group.id));
  groups.forEach(group => {
    const targetCenter = new THREE.Vector3(...group.center);
    const targetSize = new THREE.Vector3(...group.size);
    const existing = state.entries.get(group.id);
    if (!existing) {
      const initialSize = state.initialized ? new THREE.Vector3(0.01, 0.01, 0.01) : targetSize.clone();
      state.entries.set(group.id, {
        currentCenter: targetCenter.clone(),
        currentSize: initialSize.clone(),
        startCenter: targetCenter.clone(),
        startSize: initialSize,
        targetCenter,
        targetSize,
        animating: state.initialized,
        startTime: null,
      });
      return;
    }
    const targetChanged = existing.targetCenter.distanceToSquared(targetCenter) > 0.0001
      || existing.targetSize.distanceToSquared(targetSize) > 0.0001;
    if (!targetChanged) return;
    existing.startCenter.copy(existing.currentCenter);
    existing.startSize.copy(existing.currentSize);
    existing.targetCenter.copy(targetCenter);
    existing.targetSize.copy(targetSize);
    existing.animating = true;
    existing.startTime = null;
  });
  state.entries.forEach((_, id) => {
    if (!groupIds.has(id)) state.entries.delete(id);
  });
  state.initialized = true;
  useFrame(({ clock }) => {
    state.entries.forEach(entry => {
      if (!entry.animating) return;
      if (entry.startTime === null) entry.startTime = clock.elapsedTime;
      const progress = Math.min(1, (clock.elapsedTime - entry.startTime) / HIERARCHY_TRANSITION_SECONDS);
      const eased = progress * progress * (3 - 2 * progress);
      entry.currentCenter.lerpVectors(entry.startCenter, entry.targetCenter, eased);
      entry.currentSize.lerpVectors(entry.startSize, entry.targetSize, eased);
      if (progress >= 1) {
        entry.currentCenter.copy(entry.targetCenter);
        entry.currentSize.copy(entry.targetSize);
        entry.animating = false;
      }
    });
  });
  return state;
}

function RenderScheduler({ animation, continuous }: { animation: HierarchyAnimation; continuous: boolean }) {
  const invalidate = useThree(state => state.invalidate);
  useFrame(() => {
    let hierarchyAnimating = false;
    for (const entry of animation.entries.values()) {
      if (entry.animating) { hierarchyAnimating = true; break; }
    }
    if (continuous || hierarchyAnimating) invalidate();
  });
  return null;
}

// All four helpers below accept an optional trailing `out` (point/color) to
// write into. Omitting it preserves the original "always allocate a fresh
// result" behavior for their non-per-frame callers; HierarchyEdges' per-frame
// updatePositions/updateColors pass reused scratch objects instead.
function animatedGroupCenter(group: LayoutGroup, animation: HierarchyAnimation, physics: PhysicsState | null, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const bounds = animation.entries.get(group.id);
  const center = bounds?.currentCenter;
  const centerX = center ? center.x : group.center[0];
  const centerY = center ? center.y : group.center[1];
  const centerZ = center ? center.z : group.center[2];
  const physicsPosition = physics?.groupPositions.get(group.id);
  if (!physicsPosition) {
    out[0] = centerX;
    out[1] = centerY;
    out[2] = centerZ;
    return out;
  }
  out[0] = centerX + physicsPosition[0] - group.center[0];
  out[1] = centerY + physicsPosition[1] - group.center[1];
  out[2] = centerZ + physicsPosition[2] - group.center[2];
  return out;
}

function animatedGroupSize(group: LayoutGroup, animation: HierarchyAnimation, out?: [number, number, number]): [number, number, number] {
  const size = animation.entries.get(group.id)?.currentSize;
  if (!size) return group.size;
  if (!out) return [size.x, size.y, size.z];
  out[0] = size.x;
  out[1] = size.y;
  out[2] = size.z;
  return out;
}

function scaledHierarchyPoint(point: [number, number, number], targetSize: [number, number, number], currentSize: [number, number, number], out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  out[0] = point[0] * currentSize[0] / targetSize[0];
  out[1] = point[1] * currentSize[1] / targetSize[1];
  out[2] = point[2] * currentSize[2] / targetSize[2];
  return out;
}

const HIERARCHY_BASE_COLOR = new THREE.Color();
const HIERARCHY_HEAT_COLOR = new THREE.Color('#ff3d46');
const HIERARCHY_OVERDEPENDENCY_COLOR = new THREE.Color('#ff5c68');
const HIERARCHY_CONNECTION_COLOR = new THREE.Color('#ffb347');

function hierarchyColor(segment: HierarchySegment, selectedGroupId: string | null, activeGroupIds: Set<string>, activityPulseByGroupId: Map<string, ActivityPulse>, historyActivity: HistoryActivity | null, heatByGroup: Map<string, number>, connectionByGroup: Map<string, number>, connectionMode: ConnectionMode, activityMode = false, out = new THREE.Color()) {
  const highlighted = selectedGroupId === segment.group.id;
  const activity = activityMode ? activityGroupOpacity(activityPulseByGroupId.get(segment.group.id)) : historyActivity && segment.group.namespaceNodeId ? activityValue(historyActivity, segment.group.namespaceNodeId) : 1;
  const heat = heatByGroup.get(segment.group.id) ?? 0;
  const connection = connectionByGroup.get(segment.group.id) ?? 0;
  const style = HIERARCHY_BASE_COLOR
    .set(highlighted ? '#ffd166' : segment.group.virtual ? '#355b8e' : '#6578dd')
    .lerp(HIERARCHY_HEAT_COLOR, heat)
    .lerp(connectionMode === 'overdependency' ? HIERARCHY_OVERDEPENDENCY_COLOR : HIERARCHY_CONNECTION_COLOR, connection)
    .getStyle();
  const color = recencyColor(style, activity, out);
  const strength = (highlighted ? 1 : segment.group.depth === 0 ? 0.72 : segment.group.depth === 1 ? 0.5 : 0.26) * (0.12 + activity * 0.88) * (1 + heat * 0.65 + connection * 0.5);
  return color.multiplyScalar(strength);
}

function HierarchyEdges({ groups, selectedGroupId, activeGroupIds, activityPulseByGroupId, historyActivity, heatByGroup, connectionByGroup, connectionMode, activityMode, physics, animation, fullOpacity }: {
  groups: LayoutGroup[];
  selectedGroupId: string | null;
  activeGroupIds: Set<string>;
  activityPulseByGroupId: Map<string, ActivityPulse>;
  historyActivity: HistoryActivity | null;
  heatByGroup: Map<string, number>;
  connectionByGroup: Map<string, number>;
  connectionMode: ConnectionMode;
  activityMode: boolean;
  physics: PhysicsState | null;
  animation: HierarchyAnimation;
  fullOpacity: boolean;
}) {
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const segments = useMemo<HierarchySegment[]>(() => {
    const next: HierarchySegment[] = [];
    groups.forEach(group => {
      // Sphere-rendered web/domain groups (T2-C) get no box outline drawn around them.
      if (groupGeometryKind(group.activity?.kind) === 'sphere') return;
      const points = boxEdgePoints(group.size);
      for (let index = 0; index < points.length; index += 2) {
        next.push({ group, startGroup: group, endGroup: group, start: points[index], end: points[index + 1] });
      }
    });
    return next;
  }, [groupById, groups]);
  const geometry = useMemo(() => {
    const positions = new Float32Array(segments.length * 6);
    const colors = new Float32Array(segments.length * 6);
    const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', positionAttribute);
    nextGeometry.setAttribute('color', colorAttribute);
    segments.forEach((segment, index) => {
      const startCenter = animatedGroupCenter(segment.startGroup, animation, physics);
      const endCenter = animatedGroupCenter(segment.endGroup, animation, physics);
      const start = scaledHierarchyPoint(segment.start, segment.startGroup.size, animatedGroupSize(segment.startGroup, animation));
      const end = scaledHierarchyPoint(segment.end, segment.endGroup.size, animatedGroupSize(segment.endGroup, animation));
      positionAttribute.setXYZ(index * 2, startCenter[0] + start[0], startCenter[1] + start[1], startCenter[2] + start[2]);
      positionAttribute.setXYZ(index * 2 + 1, endCenter[0] + end[0], endCenter[1] + end[1], endCenter[2] + end[2]);
      const color = hierarchyColor(segment, selectedGroupId, activeGroupIds, activityPulseByGroupId, historyActivity, heatByGroup, connectionByGroup, connectionMode, activityMode);
      colorAttribute.setXYZ(index * 2, color.r, color.g, color.b);
      colorAttribute.setXYZ(index * 2 + 1, color.r, color.g, color.b);
    });
    return nextGeometry;
  }, [activeGroupIds, activityMode, activityPulseByGroupId, animation, connectionByGroup, connectionMode, groupById, heatByGroup, historyActivity, physics, segments, selectedGroupId]);
  const object = useMemo(() => {
    const nextObject = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: fullOpacity ? 1 : 0.9, depthWrite: false }));
    nextObject.frustumCulled = false;
    return nextObject;
  }, [fullOpacity, geometry]);
  // Reused every frame across every segment instead of allocating fresh
  // point/Color arrays per segment. startCenter/endCenter and start/end each
  // need their own scratch slot since both are still live (read together in
  // the setXYZ calls below) after both have been computed; sizeScratch is
  // safe to share because each size lookup is fully consumed by its
  // scaledHierarchyPoint call before the next one runs.
  const startCenterScratch = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const endCenterScratch = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const sizeScratch = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const startScratch = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const endScratch = useMemo<[number, number, number]>(() => [0, 0, 0], []);
  const colorScratch = useMemo(() => new THREE.Color(), []);
  const updatePositions = () => {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    segments.forEach((segment, index) => {
      const startCenter = animatedGroupCenter(segment.startGroup, animation, physics, startCenterScratch);
      const endCenter = animatedGroupCenter(segment.endGroup, animation, physics, endCenterScratch);
      const start = scaledHierarchyPoint(segment.start, segment.startGroup.size, animatedGroupSize(segment.startGroup, animation, sizeScratch), startScratch);
      const end = scaledHierarchyPoint(segment.end, segment.endGroup.size, animatedGroupSize(segment.endGroup, animation, sizeScratch), endScratch);
      attribute.setXYZ(index * 2, startCenter[0] + start[0], startCenter[1] + start[1], startCenter[2] + start[2]);
      attribute.setXYZ(index * 2 + 1, endCenter[0] + end[0], endCenter[1] + end[1], endCenter[2] + end[2]);
    });
    attribute.needsUpdate = true;
  };
  const updateColors = () => {
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    segments.forEach((segment, index) => {
      const color = hierarchyColor(segment, selectedGroupId, activeGroupIds, activityPulseByGroupId, historyActivity, heatByGroup, connectionByGroup, connectionMode, activityMode, colorScratch);
      attribute.setXYZ(index * 2, color.r, color.g, color.b);
      attribute.setXYZ(index * 2 + 1, color.r, color.g, color.b);
    });
    attribute.needsUpdate = true;
  };
  useEffect(() => {
    updateColors();
    updatePositions();
  }, [activeGroupIds, activityMode, activityPulseByGroupId, animation, connectionByGroup, connectionMode, geometry, heatByGroup, historyActivity, physics, segments, selectedGroupId]);
  useFrame(() => {
    updatePositions();
    if (activityMode) updateColors();
  });
  useEffect(() => () => { geometry.dispose(); (object.material as THREE.Material).dispose(); }, [geometry, object]);
  return <primitive object={object} />;
}

function GraphEdges({ edges, positions, selectedId, dimmedIds, activeHistoryFrame, historyActivity, relationshipVisibilityMode, fullOpacity }: {
  edges: CodeEdge[];
  positions: GraphPositions;
  selectedId: string | null;
  dimmedIds: Set<string>;
  activeHistoryFrame: HistoryFrame | null;
  historyActivity: HistoryActivity | null;
  relationshipVisibilityMode: NodeVisibilityMode;
  fullOpacity: boolean;
}) {
  const drawableEdges = useMemo(() => edges.filter(edge => positions.has(edge.source) && positions.has(edge.target)), [edges, positions]);
  const geometry = useMemo(() => {
    const positionsArray = new Float32Array(drawableEdges.length * 6);
    drawableEdges.forEach((edge, index) => {
      const source = positions.get(edge.source) as [number, number, number];
      const target = positions.get(edge.target) as [number, number, number];
      positionsArray.set(source, index * 6);
      positionsArray.set(target, index * 6 + 3);
    });
    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3));
    nextGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(drawableEdges.length * 6), 3));
    return nextGeometry;
  }, [drawableEdges, positions]);
  const updateColors = () => {
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    const color = new THREE.Color();
    drawableEdges.forEach((edge, index) => {
      const changed = relationshipChanged(edge, activeHistoryFrame);
      const active = selectedId === edge.source || selectedId === edge.target;
      const edgeActivity = relationshipVisibilityMode === 'updated' ? relationshipActivity(edge, historyActivity) : 1;
      color.copy(recencyColor(edge.kind === 'requires' ? '#6f8cff' : edge.kind === 'calls' ? '#47d7b0' : '#e2a0ff', edgeActivity));
      color.multiplyScalar(fullOpacity ? 1 : dimmedIds.has(edge.source) || dimmedIds.has(edge.target) ? 0.12 : changed ? 1 : active ? 0.95 : 0.3);
      for (let vertex = 0; vertex < 2; vertex += 1) attribute.setXYZ(index * 2 + vertex, color.r, color.g, color.b);
    });
    attribute.needsUpdate = true;
  };
  useEffect(() => { updateColors(); }, [activeHistoryFrame, dimmedIds, drawableEdges, fullOpacity, geometry, historyActivity, relationshipVisibilityMode, selectedId]);
  const object = useMemo(() => {
    const nextObject = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: fullOpacity ? 1 : 0.6, depthWrite: false }));
    nextObject.frustumCulled = false;
    return nextObject;
  }, [fullOpacity, geometry]);
  useEffect(() => () => { geometry.dispose(); (object.material as THREE.Material).dispose(); }, [geometry, object]);
  if (drawableEdges.length === 0) return null;
  return <primitive object={object} />;
}

function SceneContents(props: GraphCanvasProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const invalidate = useThree(state => state.invalidate);
  const followTarget = props.followTarget ?? null;
  const dimmedSessionIds = props.dimmedSessionIds ?? EMPTY_DIMMED_SESSION_IDS;
  const effectiveHistoryActivity = props.fullOpacity || props.activityMode ? null : props.historyActivity;
  const effectiveVisibilityModes = props.fullOpacity || props.activityMode ? FULL_OPACITY_VISIBILITY_MODES : props.visibilityModes;
  const effectiveRelationshipVisibilityMode: NodeVisibilityMode = props.fullOpacity || props.activityMode ? 'always' : props.relationshipVisibilityMode;
  const staticContextVisible = !props.activityMode || props.showArchitectureContext;
  const testNamespaceNames = useMemo(() => testNamespacesForGraph(props.graph), [props.graph]);
  const staticVisibleNodeIds = useMemo(() => new Set((staticContextVisible ? props.graph.nodes : [])
    .filter(node => props.visibleKinds.has(node.kind)
      && (props.showExternal || !node.external)
      && (props.showTestNamespaces || !isTestNode(node, testNamespaceNames))
      && (props.showGlobalNamespace || !isGlobalNode(node)))
    .map(node => node.id)), [props.graph.nodes, props.showExternal, props.showGlobalNamespace, props.showTestNamespaces, props.visibleKinds, staticContextVisible, testNamespaceNames]);
  const activityRelevantNodeIds = useMemo(() => {
    const relevant = new Set<string>();
    if (effectiveVisibilityModes.var === 'updated') {
      props.graph.nodes.filter(node => node.kind === 'var' && staticVisibleNodeIds.has(node.id)).forEach(node => relevant.add(node.id));
    }
    if (effectiveVisibilityModes.keyword === 'updated') {
      props.graph.nodes.filter(node => node.kind === 'keyword' && staticVisibleNodeIds.has(node.id)).forEach(node => relevant.add(node.id));
    }
    if (effectiveRelationshipVisibilityMode === 'updated') {
      props.graph.edges.filter(edge => props.edgeVisibility[edge.kind]).forEach(edge => {
        if (staticVisibleNodeIds.has(edge.source)) relevant.add(edge.source);
        if (staticVisibleNodeIds.has(edge.target)) relevant.add(edge.target);
      });
    }
    return relevant;
  }, [props.edgeVisibility, props.graph.edges, props.graph.nodes, effectiveRelationshipVisibilityMode, effectiveVisibilityModes, staticVisibleNodeIds]);
  const historyVisibilityKey = activityVisibilityKey(effectiveHistoryActivity, props.activeHistoryFrame, props.historyRevealedNodeIds, activityRelevantNodeIds);
  const visibleNodeIds = useMemo(() => new Set((staticContextVisible ? props.graph.nodes : [])
    .filter(node => nodeIsVisible(node, props.visibleKinds, effectiveVisibilityModes, props.showExternal, props.showTestNamespaces, props.showGlobalNamespace, testNamespaceNames, effectiveHistoryActivity, props.activeHistoryFrame, props.historyRevealedNodeIds))
    .map(node => node.id)), [effectiveHistoryActivity, effectiveVisibilityModes, historyVisibilityKey, props.graph.nodes, props.showExternal, props.showGlobalNamespace, props.showTestNamespaces, props.visibleKinds, staticContextVisible, testNamespaceNames]);
  const groupById = useMemo(() => new Map(props.groups.map(group => [group.id, group])), [props.groups]);
  const nodeById = useMemo(() => new Map(props.graph.nodes.map(node => [node.id, node])), [props.graph.nodes]);
  const activityPulseByNodeId = useMemo(() => {
    const pulses = new Map<string, ActivityPulse>();
    props.activityPulses.forEach(pulse => {
      if (pulse.target.kind === 'node') pulses.set(pulse.target.id, pulse);
    });
    return pulses;
  }, [props.activityPulses]);
  const activityPulseByGroupId = useMemo(() => {
    const pulses = new Map<string, ActivityPulse>();
    props.activityPulses.forEach(pulse => {
      if (pulse.target.kind === 'group') pulses.set(pulse.target.id, pulse);
    });
    props.activityPulses.forEach(pulse => {
      if (pulse.target.kind !== 'node') return;
      const node = nodeById.get(pulse.target.id);
      let group = node?.namespace ? groupById.get(`group:${node.namespace}`) : undefined;
      while (group) {
        const current = pulses.get(group.id);
        if (!current || current.startedAt <= pulse.startedAt) pulses.set(group.id, pulse);
        group = group.parentId ? groupById.get(group.parentId) : undefined;
      }
    });
    return pulses;
  }, [groupById, nodeById, props.activityPulses]);
  const visibleActivityFileLabelIds = useMemo(
    () => activityFileLabelIds(props.groups, props.activityPulses, props.selectedGroupId, props.showLabels),
    [props.activityPulses, props.groups, props.selectedGroupId, props.showLabels],
  );
  const displayGroups = useMemo(() => {
    const visibleGroupIds = new Set<string>();
    props.groups.forEach(group => {
      if (group.global && (props.orbitGlobalNamespace || !props.showGlobalNamespace)) return;
      if (group.actualNamespace && !props.showTestNamespaces && testNamespaceNames.has(group.actualNamespace)) return;
      if (group.actualNamespace && !group.global) {
        visibleGroupIds.add(group.id);
        let parentId = group.parentId;
        while (parentId) {
          visibleGroupIds.add(parentId);
          parentId = groupById.get(parentId)?.parentId ?? null;
        }
      }
    });
    const hierarchyGroups = props.groups.filter(group => {
      if (group.global && (props.orbitGlobalNamespace || !props.showGlobalNamespace)) return false;
      if (group.activity && !props.activityMode) return false;
      if (!group.activity && !staticContextVisible) return false;
      if (group.actualNamespace && !props.showTestNamespaces && testNamespaceNames.has(group.actualNamespace)) return false;
      return (props.showTestNamespaces && props.showGlobalNamespace)
        || visibleGroupIds.has(group.id)
        || group.id === 'group:unscoped'
        || Boolean(group.activity && props.activityMode);
    });
    if (!props.hierarchyLeavesOnly || props.activityMode) return hierarchyGroups;
    const parentIds = new Set(hierarchyGroups.map(group => group.parentId).filter((id): id is string => id !== null));
    return hierarchyGroups.filter(group => !parentIds.has(group.id));
  }, [groupById, props.activityMode, props.groups, props.hierarchyLeavesOnly, props.orbitGlobalNamespace, props.showGlobalNamespace, props.showTestNamespaces, staticContextVisible, testNamespaceNames]);
  const visibleEdgeKey = useMemo(() => filterEdgesByVisibleNodes(filterTopLevelFolderConnections(props.graph.edges, props.graph.nodes, props.showTopLevelFolderConnections), visibleNodeIds).filter(edge => {
    if (!props.edgeVisibility[edge.kind]) return false;
    if (effectiveRelationshipVisibilityMode === 'always') return true;
    return relationshipIsVisible(edge, effectiveHistoryActivity, props.activeHistoryFrame, props.historyRevealedNodeIds);
  }).map(edge => edge.id).join('\u0000'), [effectiveHistoryActivity, effectiveRelationshipVisibilityMode, historyVisibilityKey, props.activeHistoryFrame, props.edgeVisibility, props.graph.edges, props.graph.nodes, props.historyRevealedNodeIds, props.showTopLevelFolderConnections, visibleNodeIds]);
  const visibleEdgeIds = useMemo(() => new Set(visibleEdgeKey ? visibleEdgeKey.split('\u0000') : []), [visibleEdgeKey]);
  const visibleEdges = useMemo(() => props.graph.edges.filter(edge => visibleEdgeIds.has(edge.id)), [props.graph.edges, visibleEdgeIds]);
  const hierarchyAnimation = useHierarchyAnimation(props.groups);
  useEffect(() => {
    invalidate();
  }, [
    invalidate,
    props.activeHistoryFrame,
    props.activityRays,
    props.activitySnippetMarkers,
    props.activityPulses,
    props.connectionMode,
    props.continuousRendering,
    props.dimmedSessionIds,
    props.edgeVisibility,
    props.followTarget,
    props.fullOpacity,
    props.graph,
    props.groups,
    props.heatEnabled,
    props.heatLevels,
    props.historyActivity,
    props.historyRevealedNodeIds,
    props.physicsEnabled,
    props.positions,
    props.selectedGroupId,
    props.selectedId,
    props.showGlobalNamespace,
    props.orbitGlobalNamespace,
    props.showTopLevelFolderConnections,
    props.showHierarchy,
    props.showLabels,
    props.showTestNamespaces,
    props.visibleKinds,
  ]);
  const labels = useMemo(
    () => displayLabels(props.graph.nodes.filter(node => visibleNodeIds.has(node.id))),
    [props.graph.nodes, visibleNodeIds],
  );
  const heatByGroup = useMemo(() => {
    const values = new Map<string, number>();
    props.groups.forEach(group => {
      values.set(group.id, props.heatEnabled && group.namespaceNodeId ? props.heatLevels.get(group.namespaceNodeId) ?? 0 : 0);
    });
    [...props.groups].sort((left, right) => right.depth - left.depth).forEach(group => {
      if (!group.parentId) return;
      values.set(group.parentId, Math.max(values.get(group.parentId) ?? 0, values.get(group.id) ?? 0));
    });
    return values;
  }, [props.groups, props.heatEnabled, props.heatLevels]);
  const connectionByGroup = useMemo(() => {
    const values = new Map<string, number>();
    props.groups.forEach(group => {
      const metric = group.actualNamespace ? props.namespaceMetrics.get(group.actualNamespace) : undefined;
      values.set(group.id, connectionScore(metric, props.connectionMode));
    });
    [...props.groups].sort((left, right) => right.depth - left.depth).forEach(group => {
      if (!group.parentId) return;
      values.set(group.parentId, Math.max(values.get(group.parentId) ?? 0, values.get(group.id) ?? 0));
    });
    return values;
  }, [props.connectionMode, props.groups, props.namespaceMetrics]);
  const physics = useMemo(() => props.physicsEnabled ? createPhysicsState(props.graph, props.positions, props.groups, visibleNodeIds, visibleEdges) : null, [props.graph, props.groups, props.positions, props.physicsEnabled, visibleEdges, visibleNodeIds]);
  const physicsEdges = useMemo(() => physics ? visibleEdges.filter(edge => physics.simulatedEdgeIds.has(edge.id)) : [], [physics, visibleEdges]);
  const graphEdges = useMemo(() => physics ? visibleEdges.filter(edge => !physics.simulatedEdgeIds.has(edge.id)) : visibleEdges, [physics, visibleEdges]);
  const activeHistoryGroupIds = useMemo(() => {
    const activeIds = new Set<string>();
    props.historyRevealedNodeIds.forEach(nodeId => {
      if (!props.historyAddedNodeIds.has(nodeId)) return;
      const node = nodeById.get(nodeId);
      if (!node?.namespace) return;
      let group = groupById.get('group:' + node.namespace);
      while (group) {
        activeIds.add(group.id);
        group = group.parentId ? groupById.get(group.parentId) : undefined;
      }
    });
    return activeIds;
  }, [groupById, nodeById, props.historyAddedNodeIds, props.historyRevealedNodeIds]);
  const activeGroupIds = useMemo(
    () => {
      const next = new Set([...activeHistoryGroupIds, ...props.activeActivityGroupIds]);
      props.activeActivityNodeIds.forEach(nodeId => {
        const node = nodeById.get(nodeId);
        let group = node?.namespace ? groupById.get(`group:${node.namespace}`) : undefined;
        while (group) {
          next.add(group.id);
          group = group.parentId ? groupById.get(group.parentId) : undefined;
        }
      });
      return next;
    },
    [activeHistoryGroupIds, groupById, nodeById, props.activeActivityGroupIds, props.activeActivityNodeIds],
  );
  const namespaceSubtreeCounts = useMemo(() => new Map(props.groups
    .filter(group => group.actualNamespace)
    .map(group => [group.actualNamespace as string, group.nodeCount])), [props.groups]);
  const nodeSizeFactors = useMemo(() => new Map(props.graph.nodes
    .map(node => [node.id, nodeSizeFactor(node, namespaceSubtreeCounts)])), [props.graph.nodes, namespaceSubtreeCounts]);
  const keywordNodes = useMemo(() => props.graph.nodes.filter(node => node.kind === 'keyword' && visibleNodeIds.has(node.id)), [props.graph.nodes, visibleNodeIds]);
  const activityGroupNodeIds = useMemo(() => new Set(props.groups
    .filter(group => props.activeActivityGroupIds.has(group.id) && group.namespaceNodeId)
    .map(group => group.namespaceNodeId as string)), [props.activeActivityGroupIds, props.groups]);
  const activityVisibleIds = useMemo(() => new Set([...props.activeActivityNodeIds, ...activityGroupNodeIds]), [activityGroupNodeIds, props.activeActivityNodeIds]);
  const dimmed = (id: string) => (props.focusedIds !== null && !props.focusedIds.has(id))
    || (props.searchMatchIds !== null && !props.searchMatchIds.has(id))
    || (props.activityMode && !activityVisibleIds.has(id));
  const dimmedIds = useMemo(
    () => new Set(props.graph.nodes.filter(node => dimmed(node.id)).map(node => node.id)),
    [activityVisibleIds, props.activityMode, props.focusedIds, props.graph.nodes, props.searchMatchIds],
  );
  const renderInactiveAgents = shouldRenderInactiveAgents(props.activityMode, props.showInactiveAgents);
  const allActivityAgents = useMemo(() => [...props.activityAgents, ...props.activityInactiveAgents], [props.activityAgents, props.activityInactiveAgents]);
  const renderedActivityAgents = renderInactiveAgents ? allActivityAgents : props.activityAgents;
  const activityAgentIdentityLabels = useMemo(() => {
    const byAgentId = new Map<string, ActivityAgentLayout[]>();
    allActivityAgents.forEach(agent => {
      const members = byAgentId.get(agent.agentId) ?? [];
      members.push(agent);
      byAgentId.set(agent.agentId, members);
    });
    const labels = new Map<string, string>();
    byAgentId.forEach(members => {
      if (members.length < 2) return;
      const sessions = new Set(members.map(agent => agent.sessionId));
      members.forEach(agent => {
        const discriminator = sessions.size > 1
          ? `session · ${compactActivityIdentifier(agent.sessionId)}`
          : `node · ${compactActivityIdentifier(agent.id)}`;
        labels.set(agent.id, `agent · ${compactActivityIdentifier(agent.agentId)} · ${discriminator}`);
      });
    });
    return labels;
  }, [allActivityAgents]);
  const renderActivityAgent = (agent: ActivityAgentLayout, inactive = false) => {
    const position = props.positions.get(agent.id) ?? agent.center;
    const candidateRay = [...props.activityRays]
      .filter(ray => ray.sourceAgentNodeId === agent.id && ray.expiresAt > Date.now())
      .sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))[0];
    const latestRay = candidateRay
      && activityRayWorkspaceCompatible(candidateRay, renderedActivityAgents, allActivityAgents)
      && (!candidateRay.sourceId || !candidateRay.target.sourceId || candidateRay.sourceId === candidateRay.target.sourceId)
      ? candidateRay
      : undefined;
    const targetGroup = latestRay?.target.kind === 'group' ? groupById.get(latestRay.target.id) : undefined;
    const marker = latestRay?.targetMarkerId
      ? props.activitySnippetMarkers.find(item => item.id === latestRay.targetMarkerId)
      : undefined;
    const targetPosition = latestRay?.targetMarkerId
      ? marker && targetGroup
        ? activitySnippetMarkerPosition(marker, props.activitySnippetMarkers
          .filter(item => item.groupId === marker.groupId)
          .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
          .findIndex(item => item.id === marker.id), props.activitySnippetMarkers.filter(item => item.groupId === marker.groupId).length, targetGroup, physics, hierarchyAnimation)
        : undefined
      : latestRay
        ? targetGroup
          ? animatedGroupCenter(targetGroup, hierarchyAnimation, physics)
          : physics?.nodePositions.get(latestRay.target.id) ?? props.positions.get(latestRay.target.id)
        : undefined;
    return <ActivityAgentGlyph key={agent.id} agent={agent} position={position} targetPosition={targetPosition} targetExpiresAt={latestRay?.expiresAt} activityAt={latestRay ? Math.max(agent.updatedAt, latestRay.startedAt) : agent.updatedAt} inactive={inactive} identityLabel={activityAgentIdentityLabels.get(agent.id)} dimmedSessionIds={dimmedSessionIds} onSelect={() => props.onSelect(agent.id)} />;
  };

  return (
    <>
      <CameraReset signal={props.resetSignal} controlsRef={controlsRef} activityMode={props.activityMode} />
      <CameraMotion controlsRef={controlsRef} />
      <CameraFollow controlsRef={controlsRef} target={followTarget} />
      <RenderScheduler animation={hierarchyAnimation} continuous={props.continuousRendering} />
      <PhysicsSimulation state={physics} graph={props.graph} groups={props.groups} edges={visibleEdges} />
      <ambientLight intensity={1.5} />
      <pointLight position={[12, 18, 15]} intensity={190} color="#cfe0ff" />
      <pointLight position={[-20, -8, -12]} intensity={80} color="#765dff" />
      <Stars radius={350} depth={240} count={1800} factor={2.2} saturation={0.25} fade speed={0} />
      {props.showHierarchy && displayGroups.map(group => <GroupVolume key={group.id} group={group} selected={props.selectedGroupId === group.id} active={activeGroupIds.has(group.id)} activityMode={props.activityMode} pulseKey={props.activeHistoryFrame?.commit.id ?? props.activityPulses.map(pulse => pulse.id).join(':')} pulseColor={props.activityMode ? activityPulseByGroupId.get(group.id)?.color ?? '#7898ff' : '#ffd166'} activityPulse={activityPulseByGroupId.get(group.id)} physics={physics} animation={hierarchyAnimation} historyActivity={effectiveHistoryActivity} showLeafDetails={props.hierarchyLeavesOnly} showActivityLabel={!group.activity || group.activity.kind !== 'file' || visibleActivityFileLabelIds.has(group.id)} heat={heatByGroup.get(group.id) ?? 0} connection={connectionByGroup.get(group.id) ?? 0} connectionMode={props.connectionMode} fullOpacity={props.fullOpacity} onSelect={() => props.onSelectGroup(group.id)} />)}
      {props.activityMode && props.activityAgents.map(agent => renderActivityAgent(agent))}
      {renderInactiveAgents && props.activityInactiveAgents.map(agent => renderActivityAgent(agent, true))}
      {renderInactiveAgents && props.activityInactiveAgents.length > 0 && <ActivityInactiveGridLabel agents={props.activityInactiveAgents} />}
      {physics && <PhysicsEdges edges={physicsEdges} state={physics} selectedId={props.selectedId} activeHistoryFrame={props.activeHistoryFrame} historyActivity={effectiveHistoryActivity} relationshipVisibilityMode={effectiveRelationshipVisibilityMode} fullOpacity={props.fullOpacity} />}
      {props.showHierarchy && <HierarchyEdges groups={displayGroups} selectedGroupId={props.selectedGroupId} activeGroupIds={activeGroupIds} activityPulseByGroupId={activityPulseByGroupId} historyActivity={effectiveHistoryActivity} heatByGroup={heatByGroup} connectionByGroup={connectionByGroup} connectionMode={props.connectionMode} activityMode={props.activityMode} physics={physics} animation={hierarchyAnimation} fullOpacity={props.fullOpacity} />}
      {props.activityMode && <ActivityPulses pulses={props.activityPulses} positions={props.positions} groups={displayGroups} nodeById={nodeById} physics={physics} animation={hierarchyAnimation} dimmedSessionIds={dimmedSessionIds} />}
      {props.activityMode && <ActivityRays rays={props.activityRays} positions={props.positions} groups={displayGroups} markers={props.activitySnippetMarkers} physics={physics} animation={hierarchyAnimation} dimmedSessionIds={dimmedSessionIds} visibleAgents={renderedActivityAgents} allAgents={allActivityAgents} />}
      {props.activityMode && <ActivitySnippetMarkers markers={props.activitySnippetMarkers} groups={displayGroups} physics={physics} animation={hierarchyAnimation} dimmedSessionIds={dimmedSessionIds} />}
      <GraphEdges edges={graphEdges} positions={props.positions} selectedId={props.selectedId} dimmedIds={dimmedIds} activeHistoryFrame={props.activeHistoryFrame} historyActivity={effectiveHistoryActivity} relationshipVisibilityMode={effectiveRelationshipVisibilityMode} fullOpacity={props.fullOpacity} />
      {!props.showLabels && keywordNodes.length > 0 && <KeywordCloud nodes={keywordNodes} positions={props.positions} physics={physics} nodeSizeFactors={nodeSizeFactors} nodeScale={props.nodeScale} selectedId={props.selectedId} dimmedIds={dimmedIds} onSelect={props.onSelect} onFocus={props.onFocus} historyActivity={effectiveHistoryActivity} activityPulseByNodeId={activityPulseByNodeId} fullOpacity={props.fullOpacity} />}
      {!props.showLabels && keywordNodes.length > 0 && <KeywordPulseCloud nodes={keywordNodes} positions={props.positions} physics={physics} nodeSizeFactors={nodeSizeFactors} nodeScale={props.nodeScale} revealedNodeIds={props.historyRevealedNodeIds} historyNodeOrder={props.historyNodeOrder} historyElapsed={props.historyElapsed} historyStepMs={props.historyStepMs} />}
      {props.graph.nodes.filter(node => visibleNodeIds.has(node.id) && (props.showLabels || node.kind !== 'keyword')).map(node => {
        const position = props.positions.get(node.id);
        if (!position) return null;
        const namespaceMetric = node.kind === 'namespace' && node.namespace ? props.namespaceMetrics.get(node.namespace) : undefined;
        const connection = connectionScore(namespaceMetric, props.connectionMode);
        const activityPulse = activityPulseByNodeId.get(node.id);
        const historyPulseKey = props.historyRevealedNodeIds.has(node.id) ? `${props.activeHistoryFrame?.commit.id ?? ''}:${node.id}` : '';
        const pulseKey = [historyPulseKey, activityPulse?.id ?? ''].filter(Boolean).join('|');
        return <GraphNode key={node.id} node={node} position={position} selected={props.selectedId === node.id} dimmed={dimmed(node.id)} showLabel={props.showLabels || props.selectedId === node.id || node.kind === 'namespace'} scale={props.nodeScale} sizeFactor={nodeSizeFactors.get(node.id) ?? 1} changed={props.historyRevealedNodeIds.has(node.id)} newNamespace={props.historyAddedNodeIds.has(node.id) && node.kind === 'namespace'} activity={activityValue(effectiveHistoryActivity, node.id)} heat={props.heatEnabled ? props.heatLevels.get(node.id) ?? 0 : 0} connection={connection} connectionMode={props.connectionMode} fullOpacity={props.fullOpacity} pulseKey={pulseKey} activityPulse={activityPulse} onSelect={() => props.onSelect(node.id)} onFocus={() => props.onFocus(node.id)} physics={physics} displayLabel={labels.get(node.id)} />;
      })}
      <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} minDistance={1.5} maxDistance={420} rotateSpeed={0.55} panSpeed={0.7} />
    </>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <Canvas frameloop="demand" camera={{ position: props.activityMode ? ACTIVITY_CAMERA_POSITION : DEFAULT_CAMERA_POSITION, fov: 48, far: 1200 }} dpr={[1, 2]} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={() => props.onSelect('')}>
      <color attach="background" args={['#070b14']} />
      <fog attach="fog" args={['#070b14', 120, 760]} />
      <SceneContents {...props} />
    </Canvas>
  );
}
