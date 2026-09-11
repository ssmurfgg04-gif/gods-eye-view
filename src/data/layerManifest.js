/**
 * @module layerManifest
 * @description Static metadata + dynamic import thunks for every production
 * data layer — the lazy-registration manifest consumed by main.js.
 *
 * Boot cost background: src/main.js used to statically import all 17 layer
 * modules, so the browser parsed every layer (flights 260 KB, CCTV 196 KB,
 * military flights 184 KB, …) before the first useful globe paint even when
 * every layer was OFF. With this manifest, main.js registers lazy entries
 * instead: the toggle panel renders from the metadata below, and a layer's
 * implementation — imports, workers, dataset code — is fetched and parsed
 * only when the layer is first enabled or restored.
 *
 * Metadata contract: these fields mirror exactly what DataLayerManager and
 * the toggle panel read from an eager module (`getAll()` → name/icon/source/
 * showInTogglePanel, `_armUpdateLoop` → refreshInterval/updateInterval/
 * statsRefreshInterval). Once the real module loads, its fields replace the
 * stub wholesale, so the values below only need to stay accurate for the
 * pre-load window. Keep them in sync when renaming a layer (a drift shows up
 * as the pre-load row label, then self-corrects after first enable).
 */

/** @typedef {{id: string, name: string, icon?: string, source?: string,
 *   showInTogglePanel?: boolean, refreshInterval?: number,
 *   updateInterval?: number, statsRefreshInterval?: number,
 *   loader: (() => Promise<{default: object}|object>)} LazyLayerEntry} */

/**
 * Production layers, in the registration order main.js historically used.
 * @type {ReadonlyArray<LazyLayerEntry>}
 */
export const LAZY_LAYER_MANIFEST = Object.freeze([
  Object.freeze({
    id: 'flights',
    name: 'Live Flights',
    icon: '✈️',
    source: 'OpenSky Network',
    updateInterval: 30000,
    loader: () => import('./flights.js'),
  }),
  Object.freeze({
    id: 'military',
    name: 'Military Flights',
    icon: '🎖️',
    source: 'adsb.lol',
    updateInterval: 15000,
    loader: () => import('./militaryFlights.js'),
  }),
  Object.freeze({
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,
    loader: () => import('./earthquakes.js'),
  }),
  Object.freeze({
    id: 'satellites',
    name: 'Satellites',
    icon: '🛰️',
    source: 'CelesTrak',
    updateInterval: 0,
    refreshInterval: 5 * 60 * 1000,
    loader: () => import('./satellites.js'),
  }),
  Object.freeze({
    id: 'rocket-launches',
    name: 'Space Missions (30d)',
    icon: '🚀',
    source: 'Launch Library 2',
    updateInterval: 300000,
    loader: () => import('./rocketLaunches.js'),
  }),
  Object.freeze({
    id: 'traffic',
    name: 'Street Traffic',
    icon: '🚗',
    source: 'OpenStreetMap',
    updateInterval: 0,
    loader: () => import('./traffic.js'),
  }),
  Object.freeze({
    id: 'cctv',
    name: 'CCTV',
    icon: '📹',
    source: 'CCTV + Street View fallback',
    updateInterval: 10000,
    loader: () => import('./cctv.js'),
  }),
  Object.freeze({
    id: 'radio',
    name: 'Radio',
    icon: '◉',
    source: 'Radio Browser',
    updateInterval: 45 * 60 * 1000,
    loader: () => import('./radio.js'),
  }),
  Object.freeze({
    id: 'bikeshare',
    name: 'Bikeshare',
    icon: '🚲',
    source: 'GBFS',
    updateInterval: 60000,
    loader: () => import('./bikeshare.js'),
  }),
  Object.freeze({
    id: 'ais-live-vessels',
    name: 'Live AIS Vessels',
    icon: '◭',
    source: 'AISStream',
    updateInterval: 60000,
    statsRefreshInterval: 1000,
    loader: () => import('./aisLiveVessels.js'),
  }),
  Object.freeze({
    id: 'military-installations',
    name: 'Mapped Installations',
    icon: '⌖',
    source: 'OpenStreetMap + optional Google Maps Places',
    loader: () => import('./militaryInstallations.js'),
  }),
  Object.freeze({
    id: 'military-awareness',
    name: 'Global Context',
    icon: '◎',
    source: 'Open-source proximity context',
    showInTogglePanel: false,
    updateInterval: 0,
    statsRefreshInterval: 1000,
    loader: () => import('./militaryAwareness.js'),
  }),
  // Local bundled datasets (localLayers.js). The loader resolves the shared
  // module once and picks the individual layer object out of its array.
  Object.freeze({
    id: 'local-datacenters',
    name: 'Datacenters',
    icon: '▣',
    source: 'Local',
    loader: () => import('./localLayers.js').then((mod) => {
      const layer = mod.default.find((entry) => entry.id === 'local-datacenters');
      return { default: layer };
    }),
  }),
  Object.freeze({
    id: 'local-dams',
    name: 'Dams',
    icon: '▰',
    source: 'USACE',
    loader: () => import('./localLayers.js').then((mod) => {
      const layer = mod.default.find((entry) => entry.id === 'local-dams');
      return { default: layer };
    }),
  }),
  Object.freeze({
    id: 'telegeography-submarine-cables',
    name: 'Submarine Cables',
    icon: '≋',
    source: 'TeleGeography',
    updateInterval: 0,
    statsRefreshInterval: 500,
    loader: () => import('./localLayers.js').then((mod) => {
      const layer = mod.default.find((entry) => entry.id === 'telegeography-submarine-cables');
      return { default: layer };
    }),
  }),
  Object.freeze({
    id: 'local-firms',
    name: 'FIRMS Active Fires',
    icon: '▲',
    source: 'NASA FIRMS · LIVE',
    loader: () => import('./localLayers.js').then((mod) => {
      const layer = mod.default.find((entry) => entry.id === 'local-firms');
      return { default: layer };
    }),
  }),
  Object.freeze({
    id: 'nifc-wildfires',
    name: 'Wildfire Incidents (NIFC)',
    icon: '🔥',
    source: 'NIFC WFIGS',
    updateInterval: 5 * 60 * 1000,
    loader: () => import('./nifcWildfires.js'),
  }),
  Object.freeze({
    id: 'osm-overlays',
    name: 'Open Map Overlays',
    icon: '🗺️',
    source: 'OpenSeaMap / OpenSnowMap',
    updateInterval: 0,
    statsRefreshInterval: 5000,
    loader: () => import('./osmOverlays.js'),
  }),
]);
