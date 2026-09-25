import { DEFAULT_ACTIVITY_LAYERS, DEFAULT_VIEW_SETTINGS, loadViewSettings, saveViewSettings, VIEW_SETTINGS_KEY } from './viewSettings';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`View settings assertion failed: ${message}`);
}

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } as Storage;
}

function throwingStorage(): Storage {
  return {
    getItem: () => { throw new Error('getItem is unavailable'); },
    setItem: () => { throw new Error('setItem is unavailable'); },
    removeItem: () => { throw new Error('removeItem is unavailable'); },
    clear: () => { throw new Error('clear is unavailable'); },
    key: () => { throw new Error('key is unavailable'); },
    get length(): number { throw new Error('length is unavailable'); },
  } as Storage;
}

function stubLocalStorage(value: Storage | undefined): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true });
}

export function runViewSettingsAssertions(): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    // Defaults when nothing is stored yet.
    stubLocalStorage(memoryStorage());
    const defaults = loadViewSettings();
    expect(defaults.viewMode === 'activity', 'default view mode is activity');
    expect(defaults.repositoryPath === '', 'default repository path is empty, meaning "use the server default"');
    expect(defaults.showLabels === false, 'default showLabels matches today\'s hardcoded default');
    expect(defaults.showHierarchy === true, 'default showHierarchy matches today\'s hardcoded default');
    expect(defaults.nodeScale === 1, 'default nodeScale matches today\'s hardcoded default');
    expect(defaults.showInactiveAgents === true, 'inactive agents are shown by default to preserve the current constellation');
    expect(Object.values(defaults.activityLayers).every(value => value === true), 'every activity layer defaults to visible');
    expect(defaults.activityDimOthers === false, 'default activityDimOthers preserves today\'s remove-filter behavior (T1-G)');

    // Round-trip through separate partial saves, as App.tsx will call them.
    saveViewSettings({ viewMode: 'architecture', repositoryPath: '/tmp/my-repo', nodeScale: 1.4 });
    saveViewSettings({ activityLayers: { ...DEFAULT_ACTIVITY_LAYERS, toolbox: false } });
    saveViewSettings({ showLabels: true, showHierarchy: false });
    saveViewSettings({ showInactiveAgents: false });
    saveViewSettings({ activityDimOthers: true });
    const roundTripped = loadViewSettings();
    expect(roundTripped.viewMode === 'architecture', 'an explicit architecture preference survives reload');
    expect(roundTripped.repositoryPath === '/tmp/my-repo', 'repository path round-trips');
    expect(roundTripped.nodeScale === 1.4, 'node scale round-trips');
    expect(roundTripped.showLabels === true && roundTripped.showHierarchy === false, 'label/hierarchy flags round-trip');
    expect(roundTripped.showInactiveAgents === false, 'showInactiveAgents round-trips');
    expect(roundTripped.activityLayers.toolbox === false, 'a partial activityLayers save persists the changed toggle');
    expect(roundTripped.activityLayers.rays === true && roundTripped.activityLayers.pulses === true,
      'a partial activityLayers save does not clobber the other toggles from an earlier save');
    expect(roundTripped.activityDimOthers === true, 'a partial activityDimOthers save round-trips (T1-G)');

    globalThis.localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ viewMode: 'architecture' }));
    const legacySettings = loadViewSettings();
    expect(legacySettings.viewMode === 'architecture' && legacySettings.showInactiveAgents === true,
      'existing architecture preference is preserved and missing inactive-agent setting defaults on');

    // Junk is ignored, field by field, rather than rejecting the whole record.
    stubLocalStorage(memoryStorage());
    globalThis.localStorage.setItem(VIEW_SETTINGS_KEY, 'not valid json{');
    const fromUnparsableJunk = loadViewSettings();
    expect(fromUnparsableJunk.viewMode === DEFAULT_VIEW_SETTINGS.viewMode
      && fromUnparsableJunk.repositoryPath === DEFAULT_VIEW_SETTINGS.repositoryPath
      && fromUnparsableJunk.nodeScale === DEFAULT_VIEW_SETTINGS.nodeScale,
    'unparseable JSON falls back to full defaults instead of throwing');

    globalThis.localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({
      viewMode: 'sideways',
      repositoryPath: 42,
      activityLayers: 'nope',
      showLabels: 'yes',
      showHierarchy: null,
      nodeScale: 'huge',
      showInactiveAgents: 'nope',
      activityDimOthers: 'nope',
    }));
    const fromTypedJunk = loadViewSettings();
    expect(fromTypedJunk.viewMode === 'activity', 'an invalid viewMode value falls back to the default');
    expect(fromTypedJunk.repositoryPath === '', 'a non-string repositoryPath falls back to the default');
    expect(Object.values(fromTypedJunk.activityLayers).every(value => value === true), 'a non-object activityLayers value falls back to all-visible defaults');
    expect(fromTypedJunk.showLabels === false, 'a non-boolean showLabels falls back to the default');
    expect(fromTypedJunk.showHierarchy === true, 'a non-boolean showHierarchy falls back to the default');
    expect(fromTypedJunk.nodeScale === 1, 'a non-numeric nodeScale falls back to the default');
    expect(fromTypedJunk.showInactiveAgents === true, 'a non-boolean showInactiveAgents falls back to the visible default');
    expect(fromTypedJunk.activityDimOthers === false, 'a non-boolean activityDimOthers falls back to the default (T1-G)');

    globalThis.localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ activityLayers: { rays: 'nope', pulses: false, toolbox: 1 } }));
    const partialLayerJunk = loadViewSettings();
    expect(partialLayerJunk.activityLayers.rays === true, 'an individually invalid layer flag falls back to its own default');
    expect(partialLayerJunk.activityLayers.pulses === false, 'a validly-typed layer flag alongside junk is still honored');
    expect(partialLayerJunk.activityLayers.toolbox === true, 'a non-boolean layer flag (e.g. 1) falls back to its own default');

    // A throwing localStorage (Safari private mode, quota exceeded, a locked-down embed) must not throw out.
    stubLocalStorage(throwingStorage());
    let loadThrew = false;
    let loaded = DEFAULT_VIEW_SETTINGS;
    try {
      loaded = loadViewSettings();
    } catch {
      loadThrew = true;
    }
    expect(!loadThrew, 'loadViewSettings swallows a throwing localStorage instead of propagating');
    expect(loaded.viewMode === DEFAULT_VIEW_SETTINGS.viewMode && loaded.repositoryPath === DEFAULT_VIEW_SETTINGS.repositoryPath,
      'a throwing localStorage still yields usable defaults from loadViewSettings');

    let saveThrew = false;
    try {
      saveViewSettings({ viewMode: 'architecture' });
    } catch {
      saveThrew = true;
    }
    expect(!saveThrew, 'saveViewSettings swallows a throwing localStorage instead of propagating');

    // A missing localStorage global entirely (no DOM, or a hardened embed) is handled too.
    stubLocalStorage(undefined);
    let missingThrew = false;
    try {
      const withoutStorage = loadViewSettings();
      expect(withoutStorage.viewMode === DEFAULT_VIEW_SETTINGS.viewMode, 'a missing localStorage still yields usable defaults');
      saveViewSettings({ viewMode: 'architecture' });
    } catch {
      missingThrew = true;
    }
    expect(!missingThrew, 'a missing localStorage global does not throw from either function');
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('view settings', runViewSettingsAssertions);
