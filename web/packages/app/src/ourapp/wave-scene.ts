/**
 * Общий движок WebGL-«цифровой волны»: сетка точек-террейна, волна в вершинном
 * шейдере, диагональная решётка линий поверх, дрейфующие «дата-мошки», подъём
 * поверхности под курсором. Вынесен из лендинга (`landing/three-hero.tsx`), чтобы
 * тот же визуал переиспользовать на страницах приложения (`app-wave-scene.tsx`) без
 * дублирования ~250 строк three.js-кода. Ничего не решает про Solid/деградацию —
 * чистая функция «дай DOM-элементы → получи dispose()».
 */
import * as THREE from "three"

export type WaveColor = readonly [number, number, number]

export interface WaveSceneColors {
  low: WaveColor
  high: WaveColor
  fog: WaveColor
  mote: WaveColor
}

export type WaveMode = "webgl" | "canvas2d" | "static"

export function hasWebGL(): boolean {
  if (typeof window === "undefined") return false
  try {
    const canvas = document.createElement("canvas")
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    )
  } catch {
    return false
  }
}

/** Синхронный префлайт до создания сцены: reduced-motion → static, иначе webgl/canvas2d. */
export function initialWaveMode(): WaveMode {
  if (typeof window === "undefined") return "static"
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "static"
  return hasWebGL() ? "webgl" : "canvas2d"
}

export interface WaveSceneOptions {
  /** Контейнер, в который добавляется `renderer.domElement`. */
  mount: HTMLElement
  /** Элемент, чей `clientWidth/clientHeight` определяет размер сцены. */
  measure: HTMLElement
  /** Также проставлять `mount.style.width/height` в px (нужно, когда CSS не
   *  может само растянуть mount — напр. sticky-обёртка с height:0). */
  sizeMount?: boolean
  /** Элемент, чей скролл двигает волну к горизонту (`uFlow`). Без него — статично. */
  scroller?: HTMLElement | null
  /** Вызывается каждый кадр — так вызывающая сторона может реагировать на смену темы. */
  getColors: () => WaveSceneColors
  blending?: THREE.Blending
  cols?: number
  rows?: number
  lineCols?: number
  lineRows?: number
  moteCount?: number
  worldW?: number
  worldD?: number
  zNear?: number
  onContextLost?: () => void
}

const surfaceVertex = `
  uniform float uTime;
  uniform vec2 uSize;
  uniform vec2 uOffset;
  uniform float uZNear;
  uniform float uFlow;
  uniform vec2 uMouse;
  uniform float uMouseStr;
  varying float vH;
  varying float vFog;
  varying float vGlow;
  float waveH(vec2 g, float t){
    float h = sin(g.x*12.0 + t*0.8 + g.y*5.0) * cos(g.y*6.5 - t*0.5) * 0.8;
    h += sin(g.y*8.0 + t*0.9) * 0.30;
    h += sin(g.x*22.0 - t*0.5) * 0.06;
    return h;
  }
  void main(){
    vec2 grid = vec2(position.x, position.z);          // position = (gx, 0, gz)
    float wx = grid.x*uSize.x + uOffset.x;
    float wz = uZNear - grid.y*uSize.y + uOffset.y;
    vec2 g = vec2(grid.x, grid.y + uFlow);             // scroll streams the pattern off to the horizon
    float h  = waveH(g, uTime);
    float hp = waveH(g, uTime - 0.10);
    float vel = h - hp;
    float turn = smoothstep(0.05, 0.0, abs(vel));      // near a turning point
    float mask = smoothstep(0.35, 0.85, abs(h));       // near a crest / trough
    float glow = turn * mask;
    float d = distance(vec2(wx, wz), uMouse);
    h += exp(-d*d*0.06)*uMouseStr*1.0 + sin(d*1.2 - uTime*2.4)*exp(-d*0.30)*uMouseStr*0.16;
    vec4 mv = modelViewMatrix * vec4(wx, h, wz, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((150.0 + glow*160.0) / -mv.z, 1.5, 14.0);
    vH = h;
    vFog = clamp((-mv.z - 3.0) / 24.0, 0.0, 1.0);
    vGlow = glow;
  }
`

const pointsFragment = `
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uFog;
  varying float vH;
  varying float vFog;
  varying float vGlow;
  void main(){
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if(r2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, r2);
    vec3 col = mix(uLow, uHigh, clamp(vH*0.6 + 0.5, 0.0, 1.0)) * 1.18;
    col = mix(col, vec3(0.9, 1.0, 0.96), vGlow*0.9);   // white shimmer at turning points
    col = mix(col, uFog, vFog);
    gl_FragColor = vec4(col, a * (1.0 - vFog*0.55) * (0.95 + vGlow*0.5));
  }
`

const linesFragment = `
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uFog;
  varying float vH;
  varying float vFog;
  varying float vGlow;
  void main(){
    vec3 col = mix(uLow, uHigh, clamp(vH*0.6 + 0.5, 0.0, 1.0));
    col = mix(col, vec3(0.8, 1.0, 0.95), vGlow*0.6);
    col = mix(col, uFog, vFog);
    gl_FragColor = vec4(col, (1.0 - vFog) * 0.13 * (0.6 + vGlow));
  }
`

const moteVertex = `
  attribute float aSeed;
  uniform float uTime;
  uniform vec2 uOffset;
  varying float vFog;
  void main(){
    float y = position.y + sin(uTime*0.3 + aSeed*6.28)*0.6;
    float x = position.x + cos(uTime*0.15 + aSeed*4.0)*0.4 + uOffset.x*0.5;
    float z = position.z + uOffset.y*0.6;
    vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(44.0 / -mv.z, 1.0, 3.4);
    vFog = clamp((-mv.z - 3.0) / 24.0, 0.0, 1.0);
  }
`

const moteFragment = `
  uniform vec3 uCol;
  varying float vFog;
  void main(){
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c);
    if(r2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, r2);
    gl_FragColor = vec4(uCol, a * (1.0 - vFog) * 0.55);
  }
`

function scrollProgress(scroller: HTMLElement | null | undefined): number {
  if (scroller) {
    const max = scroller.scrollHeight - scroller.clientHeight
    if (max > 4) return Math.min(Math.max(scroller.scrollTop / max, 0), 1)
  }
  const wmax = document.documentElement.scrollHeight - window.innerHeight
  return wmax > 4 ? Math.min(Math.max(window.scrollY / wmax, 0), 1) : 0
}

export function mountWaveScene(opts: WaveSceneOptions): () => void {
  const {
    mount,
    measure,
    sizeMount = false,
    scroller = null,
    getColors,
    blending = THREE.AdditiveBlending,
    cols = 240,
    rows = 110,
    lineCols = 64,
    lineRows = 44,
    moteCount = 240,
    worldW = 60,
    worldD = 46,
    zNear = 6,
    onContextLost,
  } = opts

  const scene = new THREE.Scene()
  const aspect0 = measure.clientHeight > 0 ? measure.clientWidth / measure.clientHeight : 1
  const camera = new THREE.PerspectiveCamera(52, aspect0, 0.1, 100)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(measure.clientWidth, measure.clientHeight)
  mount.appendChild(renderer.domElement)
  renderer.domElement.style.width = "100%"
  renderer.domElement.style.height = "100%"
  renderer.domElement.style.display = "block"

  const c0 = getColors()
  const surfUniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uSize: { value: new THREE.Vector2(worldW, worldD) },
    uOffset: { value: new THREE.Vector2(0, 0) },
    uZNear: { value: zNear },
    uFlow: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, -6) },
    uMouseStr: { value: 0 },
    uLow: { value: new THREE.Vector3(...c0.low) },
    uHigh: { value: new THREE.Vector3(...c0.high) },
    uFog: { value: new THREE.Vector3(...c0.fog) },
  }

  const pCount = (cols + 1) * (rows + 1)
  const pPos = new Float32Array(pCount * 3)
  let pi = 0
  for (let zi = 0; zi <= rows; zi++) {
    for (let xi = 0; xi <= cols; xi++) {
      pPos[pi * 3] = xi / cols - 0.5
      pPos[pi * 3 + 1] = 0
      pPos[pi * 3 + 2] = zi / rows
      pi++
    }
  }
  const pointsGeo = new THREE.BufferGeometry()
  pointsGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3))
  const pointsMat = new THREE.ShaderMaterial({
    uniforms: surfUniforms,
    vertexShader: surfaceVertex,
    fragmentShader: pointsFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending,
  })
  const points = new THREE.Points(pointsGeo, pointsMat)
  points.frustumCulled = false
  scene.add(points)

  const lCount = (lineCols + 1) * (lineRows + 1)
  const lPos = new Float32Array(lCount * 3)
  let lidx = 0
  for (let zi = 0; zi <= lineRows; zi++) {
    for (let xi = 0; xi <= lineCols; xi++) {
      lPos[lidx * 3] = xi / lineCols - 0.5
      lPos[lidx * 3 + 1] = 0
      lPos[lidx * 3 + 2] = zi / lineRows
      lidx++
    }
  }
  const lineIndex: number[] = []
  for (let cz = 0; cz < lineRows; cz++) {
    for (let cx = 0; cx < lineCols; cx++) {
      const a = cz * (lineCols + 1) + cx
      const b = (cz + 1) * (lineCols + 1) + (cx + 1)
      lineIndex.push(a, b)
      if (((cx + cz) & 1) === 0) lineIndex.push(cz * (lineCols + 1) + (cx + 1), (cz + 1) * (lineCols + 1) + cx)
    }
  }
  const linesGeo = new THREE.BufferGeometry()
  linesGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3))
  linesGeo.setIndex(lineIndex)
  const linesMat = new THREE.ShaderMaterial({
    uniforms: surfUniforms,
    vertexShader: surfaceVertex,
    fragmentShader: linesFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending,
  })
  const lines = new THREE.LineSegments(linesGeo, linesMat)
  lines.frustumCulled = false
  scene.add(lines)

  const motePos = new Float32Array(moteCount * 3)
  const moteSeed = new Float32Array(moteCount)
  for (let m = 0; m < moteCount; m++) {
    motePos[m * 3] = (Math.random() - 0.5) * 30
    motePos[m * 3 + 1] = 1.4 + Math.random() * 8
    motePos[m * 3 + 2] = -Math.random() * 28 + 3
    moteSeed[m] = Math.random()
  }
  const moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3))
  moteGeo.setAttribute("aSeed", new THREE.BufferAttribute(moteSeed, 1))
  const moteUniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uOffset: { value: surfUniforms.uOffset.value },
    uCol: { value: new THREE.Vector3(...c0.mote) },
  }
  const moteMat = new THREE.ShaderMaterial({
    uniforms: moteUniforms,
    vertexShader: moteVertex,
    fragmentShader: moteFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  scene.add(motes)

  let mNx = 0
  let mNy = 0
  let mStr = 0
  let hitX = 0
  let hitZ = -6
  let tHitX = 0
  let tHitZ = -6
  let scrollP = 0
  let camX = 0
  let camY = 0
  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const ndc = new THREE.Vector2()
  const hitTarget = new THREE.Vector3()

  const onMove = (e: MouseEvent) => {
    const rect = measure.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    mNx = ((e.clientX - rect.left) / rect.width - 0.5) * 2
    mNy = ((e.clientY - rect.top) / rect.height - 0.5) * 2
    mStr = Math.min(mStr + 0.05, 0.85)
  }
  const onScroll = () => {
    scrollP = scrollProgress(scroller)
  }

  const resize = () => {
    const w = measure.clientWidth
    const h = measure.clientHeight
    if (w === 0 || h === 0) return
    if (sizeMount) {
      mount.style.width = w + "px"
      mount.style.height = h + "px"
    }
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(measure)

  let raf = 0
  let running = true
  const render = (ms: number) => {
    const t = ms / 1000
    const p = scrollP

    camX += (mNx * 0.6 - camX) * 0.05
    camY += (-mNy * 0.35 - camY) * 0.05
    camera.position.set(camX * 0.6, 1.15 + camY * 0.35, 8.5)
    camera.lookAt(0, 1.5, -18)

    ndc.set(mNx, -mNy)
    raycaster.setFromCamera(ndc, camera)
    if (raycaster.ray.intersectPlane(plane, hitTarget)) {
      tHitX = hitTarget.x
      tHitZ = hitTarget.z
    }
    hitX += (tHitX - hitX) * 0.06
    hitZ += (tHitZ - hitZ) * 0.06
    mStr *= 0.965

    const c = getColors()
    ;(surfUniforms.uLow.value as THREE.Vector3).set(...c.low)
    ;(surfUniforms.uHigh.value as THREE.Vector3).set(...c.high)
    ;(surfUniforms.uFog.value as THREE.Vector3).set(...c.fog)
    ;(moteUniforms.uCol.value as THREE.Vector3).set(...c.mote)

    surfUniforms.uTime.value = t
    surfUniforms.uFlow.value = p * 2.4
    ;(surfUniforms.uMouse.value as THREE.Vector2).set(hitX, hitZ)
    surfUniforms.uMouseStr.value = mStr
    moteUniforms.uTime.value = t

    renderer.render(scene, camera)
    if (running) raf = requestAnimationFrame(render)
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    running = false
    cancelAnimationFrame(raf)
    ro.disconnect()
    window.removeEventListener("mousemove", onMove)
    window.removeEventListener("scroll", onScroll)
    scroller?.removeEventListener("scroll", onScroll)
    document.removeEventListener("visibilitychange", onVisibility)
    renderer.domElement.removeEventListener("webglcontextlost", onContextLostInternal)
    pointsGeo.dispose()
    pointsMat.dispose()
    linesGeo.dispose()
    linesMat.dispose()
    moteGeo.dispose()
    moteMat.dispose()
    renderer.dispose()
    if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
  }

  function onContextLostInternal(e: Event) {
    e.preventDefault()
    dispose()
    onContextLost?.()
  }
  const onVisibility = () => {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(raf)
    } else if (!running && !disposed) {
      running = true
      raf = requestAnimationFrame(render)
    }
  }

  window.addEventListener("mousemove", onMove, { passive: true })
  window.addEventListener("scroll", onScroll, { passive: true })
  scroller?.addEventListener("scroll", onScroll, { passive: true })
  document.addEventListener("visibilitychange", onVisibility)
  renderer.domElement.addEventListener("webglcontextlost", onContextLostInternal, false)
  resize()
  onScroll()
  raf = requestAnimationFrame(render)

  return dispose
}
