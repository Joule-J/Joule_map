import { useEffect, useRef, useState } from 'react'
import { kml as kmlToGeoJSON } from '@tmcw/togeojson'
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from 'geojson'
import { toPng } from 'html-to-image'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

type ParsedDataset = {
  fileName: string
  geojson: FeatureCollection<Geometry | null, GeoJsonProperties>
  heatPoints: L.HeatLatLngTuple[]
  featureCount: number
  pointCount: number
  weightedPointCount: number
  weightMode: 'property' | 'density'
}

type CombinedDataset = {
  fileNames: string[]
  geojson: FeatureCollection<Geometry | null, GeoJsonProperties>
  heatPoints: L.HeatLatLngTuple[]
  featureCount: number
  pointCount: number
  weightedPointCount: number
  weightMode: 'property' | 'density'
}

type BaseMapTheme = 'light' | 'dark'

const DEFAULT_CENTER: L.LatLngExpression = [20, 0]
const DEFAULT_ZOOM = 2
const WEIGHT_KEYS = ['weight', 'intensity', 'value', 'score', 'count', 'heat', 'density']
const ROUTE_ACCENT_PRESETS = ['#38bdf8', '#14b8a6', '#f97316', '#e11d48', '#f8fafc']
const ROUTE_LINE_WEIGHT = 4
const ROUTE_POINT_RADIUS = 3
const ROUTE_POINT_STROKE = 2
const FLOW_COLORS = ['#ef4444', '#f97316', '#facc15', '#38bdf8', '#2563eb']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseNumericWeight(properties: GeoJsonProperties | null): number | null {
  if (!properties) {
    return null
  }

  for (const [key, value] of Object.entries(properties)) {
    if (!WEIGHT_KEYS.includes(key.toLowerCase())) {
      continue
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return null
}

function normalizeWeight(rawWeight: number | null): number {
  if (rawWeight === null) {
    return 0.55
  }

  if (rawWeight <= 0) {
    return 0.1
  }

  if (rawWeight <= 1) {
    return rawWeight
  }

  return Math.min(rawWeight / 100, 1)
}

function pushCoordinatePoint(
  coordinates: unknown,
  weight: number,
  collection: L.HeatLatLngTuple[],
) {
  if (!Array.isArray(coordinates)) {
    return
  }

  const [lng, lat] = coordinates
  if (isFiniteNumber(lng) && isFiniteNumber(lat)) {
    collection.push([lat, lng, weight])
    return
  }

  for (const child of coordinates) {
    pushCoordinatePoint(child, weight, collection)
  }
}

function extractGeometryPoints(
  geometry: Geometry | null,
  weight: number,
  collection: L.HeatLatLngTuple[],
) {
  if (!geometry) {
    return
  }

  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) {
      extractGeometryPoints(child, weight, collection)
    }
    return
  }

  pushCoordinatePoint(geometry.coordinates, weight, collection)
}

function featureToHeatPoints(feature: Feature<Geometry | null, GeoJsonProperties>): {
  points: L.HeatLatLngTuple[]
  hasPropertyWeight: boolean
} {
  if (!feature.geometry) {
    return { points: [], hasPropertyWeight: false }
  }

  const rawWeight = parseNumericWeight(feature.properties ?? null)
  const normalizedWeight = normalizeWeight(rawWeight)
  const points: L.HeatLatLngTuple[] = []

  extractGeometryPoints(feature.geometry, normalizedWeight, points)

  return {
    points,
    hasPropertyWeight: rawWeight !== null,
  }
}

function parseKmlText(fileName: string, text: string): ParsedDataset {
  const xml = new DOMParser().parseFromString(text, 'text/xml')
  const parserError = xml.querySelector('parsererror')

  if (parserError) {
    throw new Error('This file could not be parsed as valid KML.')
  }

  const geojson = kmlToGeoJSON(xml)
  geojson.features = geojson.features.map((feature, index) => ({
    ...feature,
    properties: {
      ...feature.properties,
      sourceFile: fileName,
      sourceIndex: index,
    },
  }))
  const allHeatPoints: L.HeatLatLngTuple[] = []
  let weightedFeatures = 0

  for (const feature of geojson.features) {
    const { points, hasPropertyWeight } = featureToHeatPoints(feature)
    allHeatPoints.push(...points)

    if (hasPropertyWeight) {
      weightedFeatures += 1
    }
  }

  if (geojson.features.length === 0) {
    throw new Error('No map features were found in this KML file.')
  }

  if (allHeatPoints.length === 0) {
    throw new Error('The KML was converted, but no coordinates were found for a heat map.')
  }

  return {
    fileName,
    geojson,
    heatPoints: allHeatPoints,
    featureCount: geojson.features.length,
    pointCount: allHeatPoints.length,
    weightedPointCount: weightedFeatures,
    weightMode: weightedFeatures > 0 ? 'property' : 'density',
  }
}

function buildPopupContent(properties: GeoJsonProperties | null): string {
  if (!properties) {
    return 'Unnamed route item'
  }

  const parts: string[] = []
  const name = typeof properties.name === 'string' ? properties.name : null
  const sourceFile = typeof properties.sourceFile === 'string' ? properties.sourceFile : null
  const description =
    typeof properties.description === 'string' ? properties.description.trim() : null

  if (name) {
    parts.push(`<strong>${name}</strong>`)
  }

  if (sourceFile) {
    parts.push(`Source: ${sourceFile}`)
  }

  if (description) {
    parts.push(description)
  }

  return parts.join('<br />') || 'Unnamed route item'
}

function getFeatureIntensity(feature: Feature<Geometry | null, GeoJsonProperties>): number {
  return normalizeWeight(parseNumericWeight(feature.properties ?? null))
}

function getFlowColor(intensity: number): string {
  if (intensity < 0.28) {
    return FLOW_COLORS[0]
  }

  if (intensity < 0.48) {
    return FLOW_COLORS[1]
  }

  if (intensity < 0.68) {
    return FLOW_COLORS[2]
  }

  if (intensity < 0.84) {
    return FLOW_COLORS[3]
  }

  return FLOW_COLORS[4]
}

function combineDatasets(datasets: ParsedDataset[]): CombinedDataset {
  const features = datasets.flatMap((dataset) => dataset.geojson.features)
  const heatPoints = datasets.flatMap((dataset) => dataset.heatPoints)
  const weightedPointCount = datasets.reduce(
    (total, dataset) => total + dataset.weightedPointCount,
    0,
  )

  return {
    fileNames: datasets.map((dataset) => dataset.fileName),
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    heatPoints,
    featureCount: datasets.reduce((total, dataset) => total + dataset.featureCount, 0),
    pointCount: datasets.reduce((total, dataset) => total + dataset.pointCount, 0),
    weightedPointCount,
    weightMode: weightedPointCount > 0 ? 'property' : 'density',
  }
}

function downloadGeoJSON(dataset: CombinedDataset) {
  const fileName =
    dataset.fileNames.length === 1
      ? dataset.fileNames[0].replace(/\.kml$/i, '') || 'converted-map'
      : `combined-${dataset.fileNames.length}-files`
  const blob = new Blob([JSON.stringify(dataset.geojson, null, 2)], {
    type: 'application/geo+json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = `${fileName}.geojson`
  link.click()

  URL.revokeObjectURL(url)
}

function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const exportFrameRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragStartYRef = useRef<number | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseTileLayerRef = useRef<L.TileLayer | null>(null)
  const flowLayerRef = useRef<L.GeoJSON | null>(null)
  const geoJsonLayerRef = useRef<L.GeoJSON | null>(null)
  const [dataset, setDataset] = useState<CombinedDataset | null>(null)
  const [error, setError] = useState<string>('')
  const [isBusy, setIsBusy] = useState(false)
  const [isExportingPng, setIsExportingPng] = useState(false)
  const [baseMapTheme, setBaseMapTheme] = useState<BaseMapTheme>('dark')
  const [routeAccent, setRouteAccent] = useState('#38bdf8')
  const [showIntro, setShowIntro] = useState(true)
  const [isAuthorized, setIsAuthorized] = useState(false)
  const [isPanelOpen, setIsPanelOpen] = useState(true)
  const [sheetOffsetY, setSheetOffsetY] = useState(0)
  const [isDraggingSheet, setIsDraggingSheet] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowIntro(false)
    }, 1500)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return
    }

    const map = L.map(mapElementRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
    })

    L.control
      .zoom({
        position: 'bottomright',
      })
      .addTo(map)

    map.createPane('base-tiles')
    const basePane = map.getPane('base-tiles')
    if (basePane) {
      basePane.style.zIndex = '200'
    }

    map.createPane('flow-heat')
    const flowPane = map.getPane('flow-heat')
    if (flowPane) {
      flowPane.style.zIndex = '360'
      flowPane.style.filter = 'blur(10px)'
      flowPane.style.opacity = '0.96'
    }

    map.createPane('routes')
    const routePane = map.getPane('routes')
    if (routePane) {
      routePane.style.zIndex = '420'
    }

    baseTileLayerRef.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      pane: 'base-tiles',
      className: 'basemap-tiles',
    }).addTo(map)

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
      baseTileLayerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapElementRef.current) {
      return
    }

    mapElementRef.current.dataset.theme = baseMapTheme
  }, [baseMapTheme])

  useEffect(() => {
    if (!isPanelOpen) {
      setSheetOffsetY(0)
      setIsDraggingSheet(false)
      dragStartYRef.current = null
    }
  }, [isPanelOpen])

  useEffect(() => {
    const map = mapRef.current
    if (!map) {
      return
    }

    flowLayerRef.current?.remove()
    geoJsonLayerRef.current?.remove()

    if (!dataset) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM)
      return
    }

    flowLayerRef.current = L.geoJSON(dataset.geojson, {
      pane: 'flow-heat',
      style: (feature) => {
        const intensity = feature ? getFeatureIntensity(feature) : 0.55
        const flowColor = getFlowColor(intensity)
        const isLine = Boolean(feature?.geometry?.type?.includes('Line'))
        const isPolygon = Boolean(feature?.geometry?.type?.includes('Polygon'))

        return {
          color: flowColor,
          weight: isLine ? 18 + Math.round(intensity * 10) : 0,
          opacity: isLine ? 0.26 + intensity * 0.18 : 0,
          fillColor: flowColor,
          fillOpacity: isPolygon ? 0.1 + intensity * 0.16 : 0,
          lineCap: 'round',
          lineJoin: 'round',
        }
      },
      pointToLayer: (feature, latlng) => {
        const intensity = feature ? getFeatureIntensity(feature) : 0.55

        return L.circleMarker(latlng, {
          pane: 'flow-heat',
          radius: 10 + Math.round(intensity * 8),
          stroke: false,
          fillColor: getFlowColor(intensity),
          fillOpacity: 0.2 + intensity * 0.22,
          className: 'flow-point',
        })
      },
    }).addTo(map)

    geoJsonLayerRef.current = L.geoJSON(dataset.geojson, {
      pane: 'routes',
      style: (feature) => {
        return {
          color: routeAccent,
          weight: feature?.geometry?.type?.includes('Line') ? ROUTE_LINE_WEIGHT : 2,
          opacity: 0.95,
          fillColor: routeAccent,
          fillOpacity: feature?.geometry?.type?.includes('Polygon') ? 0.12 : 0.22,
        }
      },
      pointToLayer: (_, latlng) => {
        return L.circleMarker(latlng, {
          pane: 'routes',
          radius: ROUTE_POINT_RADIUS,
          color: '#ffffff',
          weight: ROUTE_POINT_STROKE,
          fillColor: routeAccent,
          fillOpacity: 1,
        })
      },
      onEachFeature: (feature, layer) => {
        layer.bindPopup(buildPopupContent(feature.properties ?? null))
      },
    }).addTo(map)

    geoJsonLayerRef.current.bringToFront()

    const bounds = geoJsonLayerRef.current.getBounds()
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.14))
    }
  }, [dataset, routeAccent])

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) {
      return
    }

    setIsBusy(true)
    setError('')

    try {
      const parsedDatasets = await Promise.all(
        files.map(async (file) => {
          const text = await file.text()
          return parseKmlText(file.name, text)
        }),
      )
      setDataset(combineDatasets(parsedDatasets))
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : 'The selected KML files could not be processed.'
      setDataset(null)
      setError(message)
    } finally {
      setIsBusy(false)
      event.target.value = ''
    }
  }

  async function handlePngExport() {
    if (!exportFrameRef.current || !dataset) {
      return
    }

    setIsExportingPng(true)

    try {
      const dataUrl = await toPng(exportFrameRef.current, {
        cacheBust: true,
        pixelRatio: Math.max(window.devicePixelRatio, 2),
        backgroundColor: '#0f172a',
      })

      const link = document.createElement('a')
      const fileName =
        dataset.fileNames.length === 1
          ? dataset.fileNames[0].replace(/\.kml$/i, '') || 'route-map'
          : `route-map-${dataset.fileNames.length}-files`

      link.href = dataUrl
      link.download = `${fileName}.png`
      link.click()
    } catch {
      setError('PNG export failed. Try again after the map finishes rendering.')
    } finally {
      setIsExportingPng(false)
    }
  }

  function handleSheetTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (window.innerWidth > 900) {
      return
    }

    if (event.cancelable) {
      event.preventDefault()
    }

    dragStartYRef.current = event.touches[0]?.clientY ?? null
    setIsDraggingSheet(true)
  }

  function handleSheetTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    if (!isDraggingSheet || dragStartYRef.current === null) {
      return
    }

    if (event.cancelable) {
      event.preventDefault()
    }

    const currentY = event.touches[0]?.clientY ?? dragStartYRef.current
    const nextOffset = Math.max(0, currentY - dragStartYRef.current)

    setSheetOffsetY(nextOffset)
  }

  function handleSheetTouchEnd() {
    if (!isDraggingSheet) {
      return
    }

    const shouldClose = sheetOffsetY > 120

    setIsDraggingSheet(false)
    dragStartYRef.current = null

    if (shouldClose) {
      setIsPanelOpen(false)
      setSheetOffsetY(0)
      return
    }

    setSheetOffsetY(0)
  }

  function handleSheetTouchCancel() {
    setIsDraggingSheet(false)
    dragStartYRef.current = null
    setSheetOffsetY(0)
  }

  function handleFilePickerOpen() {
    fileInputRef.current?.click()
  }

  return (
    <main className="app-shell">
      {showIntro ? (
        <section className="intro-screen">
          <div className="intro-mark">
            <strong>Joule Inc.</strong>
            <div className="intro-bar"></div>
          </div>
        </section>
      ) : null}

      {!showIntro && !isAuthorized ? (
        <section className="gate-screen">
          <div className="gate-panel">
            <span className="gate-kicker">Access Control</span>
            <h2>mustafaya biat et</h2>
            <button
              type="button"
              className="gate-button"
              onClick={() => setIsAuthorized(true)}
            >
              mustafaya biat ediyorum
            </button>
          </div>
        </section>
      ) : null}

      <header className="app-header">
        <div className="header-content">
          <h1 className="header-title">Joule Inc.</h1>
        </div>
      </header>

      <section
        className={
          !showIntro && isAuthorized
            ? `workspace is-live${isPanelOpen ? '' : ' panel-closed'}`
            : 'workspace'
        }
      >
        <section className="map-panel">
          <button
            type="button"
            className="panel-toggle-open"
            onClick={() => setIsPanelOpen(true)}
          >
            Settings
          </button>
          <div ref={exportFrameRef} className="map-frame export-frame">
            <div ref={mapElementRef} className="map-canvas" />
          </div>
        </section>

        <button
          type="button"
          className={isPanelOpen ? 'mobile-panel-backdrop active' : 'mobile-panel-backdrop'}
          aria-label="Close settings panel"
          onClick={() => setIsPanelOpen(false)}
        />

        <aside
          className={`${isPanelOpen ? 'side-panel' : 'side-panel hidden'}${isDraggingSheet ? ' dragging' : ''}`}
          aria-hidden={!isPanelOpen}
          style={isPanelOpen ? { transform: `translateY(${sheetOffsetY}px)` } : undefined}
        >
          <div
            className="panel-drag-handle"
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
            onTouchCancel={handleSheetTouchCancel}
          >
            <span />
          </div>
          <button
            type="button"
            className="panel-close-button"
            onClick={() => setIsPanelOpen(false)}
          >
            Close
          </button>
          <div className="panel-card">
            <span className="panel-title">Base Map Theme</span>
            <div className="theme-switcher-buttons compact">
              <button
                type="button"
                className={baseMapTheme === 'light' ? 'theme-button active' : 'theme-button'}
                onClick={() => setBaseMapTheme('light')}
              >
                Light
              </button>
              <button
                type="button"
                className={baseMapTheme === 'dark' ? 'theme-button active' : 'theme-button'}
                onClick={() => setBaseMapTheme('dark')}
              >
                Dark
              </button>
            </div>
          </div>

          <div className="panel-card">
            <span className="panel-title">Route Color</span>
            <div className="theme-switcher-buttons compact">
              {ROUTE_ACCENT_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={routeAccent === color ? 'swatch-button active' : 'swatch-button'}
                  style={{ backgroundColor: color }}
                  onClick={() => setRouteAccent(color)}
                  aria-label={`Set route color ${color}`}
                />
              ))}
              <label className="color-input-shell" aria-label="Custom route color">
                <input
                  type="color"
                  value={routeAccent}
                  onChange={(event) => setRouteAccent(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div
            className="upload-card compact"
            role="button"
            tabIndex={0}
            onClick={handleFilePickerOpen}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleFilePickerOpen()
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".kml,application/vnd.google-earth.kml+xml"
              multiple
              onChange={handleFileChange}
            />
            <span className="upload-title">
              {isBusy ? 'Processing...' : 'Upload KML'}
            </span>
          </div>

          <button
            type="button"
            className="download-button compact"
            onClick={() => dataset && downloadGeoJSON(dataset)}
            disabled={!dataset}
          >
            GeoJSON
          </button>

          <button
            type="button"
            className="download-button secondary-button compact"
            onClick={handlePngExport}
            disabled={!dataset || isExportingPng}
          >
            {isExportingPng ? 'PNG...' : 'PNG'}
          </button>

          <div className="panel-card stats-grid">
            <div>
              <span className="metric-label">Features</span>
              <strong className="metric-value">{dataset?.featureCount ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Points</span>
              <strong className="metric-value">{dataset?.pointCount ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Files</span>
              <strong className="metric-value">{dataset?.fileNames.length ?? 0}</strong>
            </div>
            <div>
              <span className="metric-label">Mode</span>
              <strong className="metric-value">
                {dataset ? (dataset.weightMode === 'property' ? 'Weighted' : 'Density') : '-'}
              </strong>
            </div>
          </div>

          <div className="panel-card">
            <h3 className="panel-title">Loaded Files</h3>
            {dataset ? (
              <ul className="file-list">
                {dataset.fileNames.map((fileName) => (
                  <li key={fileName}>{fileName}</li>
                ))}
              </ul>
            ) : (
              <p className="metric-value empty">No file uploaded yet</p>
            )}
          </div>

          {error ? (
            <div className="panel-card error-card">
              <h3 className="panel-title">Import Error</h3>
              <p>{error}</p>
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  )
}

export default App
