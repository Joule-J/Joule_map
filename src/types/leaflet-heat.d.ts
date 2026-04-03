import 'leaflet'

declare module 'leaflet' {
  export type HeatLatLngTuple = [number, number, number?]

  export interface HeatLayerOptions {
    minOpacity?: number
    maxZoom?: number
    max?: number
    radius?: number
    blur?: number
    gradient?: Record<number, string>
    pane?: string
  }

  export interface HeatLayer extends Layer {
    setLatLngs(latlngs: HeatLatLngTuple[]): this
    addLatLng(latlng: HeatLatLngTuple): this
    setOptions(options: HeatLayerOptions): this
    redraw(): this
  }

  export function heatLayer(latlngs: HeatLatLngTuple[], options?: HeatLayerOptions): HeatLayer
}
