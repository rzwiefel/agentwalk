import type { ActivityMode } from './activity/types';

// Persisted view settings (T1-A). Everything here is read on mount and written
// back on change; the session filter is deliberately excluded because session
// ids are ephemeral and would only ever match a session that no longer exists.

export interface ActivityLayerToggles {
  rays: boolean;
  pulses: boolean;
  snippetMarkers: boolean;
  /** Activity groups of kind 'project' | 'directory' | 'file'. */
  filePlane: boolean;
  /** Activity groups of kind 'bash' | 'tool'. */
  toolbox: boolean;
}

export interface ViewSettings {
  viewMode: ActivityMode;
  /** Last-used repository path. Empty means "use the server's --repo-root default". */
  repositoryPath: string;
  activityLayers: ActivityLayerToggles;
  showLabels: boolean;
  showHierarchy: boolean;
  nodeScale: number;
  showInactiveAgents: boolean;
  /**
   * T1-G: when true, sessions excluded by the (unpersisted, ephemeral) session
   * filter are dimmed on the canvas instead of removed from layout. This is the
   * mode preference, a durable setting like activityLayers; the filter/solo
   * selection it applies to stays unpersisted for the same reason session ids
   * are excluded above.
   */
  activityDimOthers: boolean;
}

export const VIEW_SETTINGS_KEY = 'codewalk.viewSettings.v1';

export const DEFAULT_ACTIVITY_LAYERS: ActivityLayerToggles = {
  rays: true,
  pulses: true,
  snippetMarkers: true,
  filePlane: true,
  toolbox: true,
};

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  viewMode: 'activity',
  repositoryPath: '',
  activityLayers: DEFAULT_ACTIVITY_LAYERS,
  showLabels: false,
  showHierarchy: true,
  nodeScale: 1,
  showInactiveAgents: true,
  activityDimOthers: false,
};

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isActivityMode(value: unknown): value is ActivityMode {
  return value === 'activity' || value === 'architecture';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function sanitizeActivityLayers(value: unknown): ActivityLayerToggles {
  const input = record(value);
  return {
    rays: isBoolean(input.rays) ? input.rays : DEFAULT_ACTIVITY_LAYERS.rays,
    pulses: isBoolean(input.pulses) ? input.pulses : DEFAULT_ACTIVITY_LAYERS.pulses,
    snippetMarkers: isBoolean(input.snippetMarkers) ? input.snippetMarkers : DEFAULT_ACTIVITY_LAYERS.snippetMarkers,
    filePlane: isBoolean(input.filePlane) ? input.filePlane : DEFAULT_ACTIVITY_LAYERS.filePlane,
    toolbox: isBoolean(input.toolbox) ? input.toolbox : DEFAULT_ACTIVITY_LAYERS.toolbox,
  };
}

function sanitizeViewSettings(value: unknown): ViewSettings {
  const input = record(value);
  return {
    viewMode: isActivityMode(input.viewMode) ? input.viewMode : DEFAULT_VIEW_SETTINGS.viewMode,
    repositoryPath: typeof input.repositoryPath === 'string' ? input.repositoryPath : DEFAULT_VIEW_SETTINGS.repositoryPath,
    activityLayers: sanitizeActivityLayers(input.activityLayers),
    showLabels: isBoolean(input.showLabels) ? input.showLabels : DEFAULT_VIEW_SETTINGS.showLabels,
    showHierarchy: isBoolean(input.showHierarchy) ? input.showHierarchy : DEFAULT_VIEW_SETTINGS.showHierarchy,
    nodeScale: isFiniteNumber(input.nodeScale) ? input.nodeScale : DEFAULT_VIEW_SETTINGS.nodeScale,
    showInactiveAgents: isBoolean(input.showInactiveAgents) ? input.showInactiveAgents : DEFAULT_VIEW_SETTINGS.showInactiveAgents,
    activityDimOthers: isBoolean(input.activityDimOthers) ? input.activityDimOthers : DEFAULT_VIEW_SETTINGS.activityDimOthers,
  };
}

function defaultViewSettings(): ViewSettings {
  return { ...DEFAULT_VIEW_SETTINGS, activityLayers: { ...DEFAULT_ACTIVITY_LAYERS } };
}

/** Reads persisted view settings, falling back to typed defaults for anything missing, invalid, or unreadable. */
export function loadViewSettings(): ViewSettings {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return defaultViewSettings();
    return sanitizeViewSettings(JSON.parse(raw));
  } catch {
    return defaultViewSettings();
  }
}

/** Merges `partial` onto the currently persisted settings (or the defaults) and writes the result back. Never throws. */
export function saveViewSettings(partial: Partial<ViewSettings>): void {
  try {
    const current = loadViewSettings();
    const next: ViewSettings = {
      ...current,
      ...partial,
      activityLayers: partial.activityLayers
        ? { ...current.activityLayers, ...partial.activityLayers }
        : current.activityLayers,
    };
    globalThis.localStorage?.setItem(VIEW_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private browsing, quota exceeded, no DOM); persistence is best-effort.
  }
}
