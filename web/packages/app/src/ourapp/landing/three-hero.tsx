/**
 * WebGL-«цифровой мир» лендинга: закреплённая плоскость точек-террейна, всегда в
 * кадре за контентом. Волна считается в вершинном шейдере (GPU); при прокрутке
 * рисунок волны «утекает» к горизонту (uFlow) — как титры «Звёздных войн», при
 * этом сама плоскость не уходит с экрана. Поверх — диагональная решётка (линии) и
 * дрейфующие «дата-мошки». Курсор мягко поднимает поверхность под собой (луч→
 * плоскость + демпфирование). На сломе гребня точки коротко вспыхивают (vGlow).
 *
 * DEFAULT-экспорт: граница lazy-чанка (`landing-page.tsx` грузит его
 * `lazy(() => import("./three-hero"))`) — three.js не попадает в основной бандл.
 *
 * Деградация (синхронный префлайт `initialMode()`, до создания сцены):
 *  - prefers-reduced-motion → статичный CSS-кадр (без canvas и rAF);
 *  - нет WebGL → 2D `DotWaveBackground`.
 * Рантайм-страховка: `webglcontextlost` → полный dispose + падение на 2D-фон.
 *
 * Прокрутка берётся у скролл-контейнера `.isaac-lp` (лендинг скроллится внутри
 * него, не окном) с фолбэком на window. Производительность: powerPreference
 * "low-power", DPR≤2, пауза на visibilitychange, полный dispose в onCleanup и при
 * потере контекста (points + lines + motes геометрии/материалы + renderer).
 */
import * as THREE from "three"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { DotWaveBackground } from "@/ourapp/dot-wave-bg"

// Плотная сетка точек и более грубая — под диагональную решётку линий.
const COLS = 240
const ROWS = 110
const LC = 64
const LR = 44

// Мир: широкая, глубокая плоскость. Волна по Y, глубина по Z (ближе → +Z).
const WORLD_W = 60
const WORLD_D = 46
const ZNEAR = 6

function hasWebGL(): boolean {
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

type Mode = "webgl" | "canvas2d" | "static"

function initialMode(): Mode {
  if (typeof window === "undefined") return "static"
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "static"
  return hasWebGL() ? "webgl" : "canvas2d"
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

/** Прокрутка лендинга живёт в контейнере `.isaac-lp`; фолбэк — окно. */
function scrollProgress(scroller: HTMLElement | null): number {
  if (scroller) {
    const max = scroller.scrollHeight - scroller.clientHeight
    if (max > 4) return Math.min(Math.max(scroller.scrollTop / max, 0), 1)
  }
  const wmax = document.documentElement.scrollHeight - window.innerHeight
  return wmax > 4 ? Math.min(Math.max(window.scrollY / wmax, 0), 1) : 0
}

export default function ThreeHero() {
  const [mode, setMode] = createSignal<Mode>(initialMode())
  let container: HTMLDivElement | undefined

  onMount(() => {
    if (mode() !== "webgl") return
    const host = container
    if (!host) return
    const scroller = host.closest(".isaac-lp") as HTMLElement | null

    const scene = new THREE.Scene()
    // Гвард на нулевую высоту хоста в момент onMount (как в resize()) — иначе первый
    // кадр мог бы получить NaN-aspect до первого колбэка ResizeObserver.
    const aspect0 = host.clientHeight > 0 ? host.clientWidth / host.clientHeight : 1
    const camera = new THREE.PerspectiveCamera(52, aspect0, 0.1, 100)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(host.clientWidth, host.clientHeight)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    renderer.domElement.style.display = "block"

    // Общие uniform'ы поверхности — один объект на точки и линии (обновляем раз/кадр).
    const surfUniforms: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uSize: { value: new THREE.Vector2(WORLD_W, WORLD_D) },
      uOffset: { value: new THREE.Vector2(0, 0) }, // резерв под пан мира (сейчас 0, без сдвига)
      uZNear: { value: ZNEAR },
      uFlow: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, -6) },
      uMouseStr: { value: 0 },
      uLow: { value: new THREE.Vector3(0.043, 0.325, 0.271) }, // emerald-deep
      uHigh: { value: new THREE.Vector3(0.404, 0.941, 0.847) }, // aqua
      uFog: { value: new THREE.Vector3(0.031, 0.066, 0.055) },
    }

    // Плотная сетка точек: position = (gx ∈ [-0.5,0.5], 0, gz ∈ [0,1]).
    const pCount = (COLS + 1) * (ROWS + 1)
    const pPos = new Float32Array(pCount * 3)
    let pi = 0
    for (let zi = 0; zi <= ROWS; zi++) {
      for (let xi = 0; xi <= COLS; xi++) {
        pPos[pi * 3] = xi / COLS - 0.5
        pPos[pi * 3 + 1] = 0
        pPos[pi * 3 + 2] = zi / ROWS
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
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(pointsGeo, pointsMat)
    points.frustumCulled = false
    scene.add(points)

    // Грубая сетка + индексы диагоналей (местами крест-накрест) — «плетение» линий.
    const lCount = (LC + 1) * (LR + 1)
    const lPos = new Float32Array(lCount * 3)
    let lidx = 0
    for (let zi = 0; zi <= LR; zi++) {
      for (let xi = 0; xi <= LC; xi++) {
        lPos[lidx * 3] = xi / LC - 0.5
        lPos[lidx * 3 + 1] = 0
        lPos[lidx * 3 + 2] = zi / LR
        lidx++
      }
    }
    const lineIndex: number[] = []
    for (let cz = 0; cz < LR; cz++) {
      for (let cx = 0; cx < LC; cx++) {
        const a = cz * (LC + 1) + cx
        const b = (cz + 1) * (LC + 1) + (cx + 1)
        lineIndex.push(a, b)
        if (((cx + cz) & 1) === 0) lineIndex.push(cz * (LC + 1) + (cx + 1), (cz + 1) * (LC + 1) + cx)
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
      blending: THREE.AdditiveBlending,
    })
    const lines = new THREE.LineSegments(linesGeo, linesMat)
    lines.frustumCulled = false
    scene.add(lines)

    // Дата-мошки: дрейфующие точки над плоскостью.
    const MOTES = 240
    const motePos = new Float32Array(MOTES * 3)
    const moteSeed = new Float32Array(MOTES)
    for (let m = 0; m < MOTES; m++) {
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
      uCol: { value: new THREE.Vector3(0.404, 0.941, 0.847) },
    }
    const moteMat = new THREE.ShaderMaterial({
      uniforms: moteUniforms,
      vertexShader: moteVertex,
      fragmentShader: moteFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const motes = new THREE.Points(moteGeo, moteMat)
    motes.frustumCulled = false
    scene.add(motes)

    // Курсор → NDC; демпфированная цель под курсором на плоскости y=0.
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
      mNx = (e.clientX / window.innerWidth - 0.5) * 2
      mNy = (e.clientY / window.innerHeight - 0.5) * 2
      mStr = Math.min(mStr + 0.05, 0.85)
    }
    const onScroll = () => {
      scrollP = scrollProgress(scroller)
    }

    const resize = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    let raf = 0
    let running = true
    const render = (ms: number) => {
      const t = ms / 1000
      const p = scrollP

      camX += (mNx * 0.6 - camX) * 0.05
      camY += (-mNy * 0.35 - camY) * 0.05
      camera.position.set(camX * 0.6, 1.15 + camY * 0.35, 8.5) // low camera — frame flies up from below
      camera.lookAt(0, 1.5, -18)

      // мягкое «догоняние» точки под курсором (луч камеры → плоскость)
      ndc.set(mNx, -mNy)
      raycaster.setFromCamera(ndc, camera)
      if (raycaster.ray.intersectPlane(plane, hitTarget)) {
        tHitX = hitTarget.x
        tHitZ = hitTarget.z
      }
      hitX += (tHitX - hitX) * 0.06
      hitZ += (tHitZ - hitZ) * 0.06
      mStr *= 0.965

      surfUniforms.uTime.value = t
      surfUniforms.uFlow.value = p * 2.4 // scroll → pattern recede toward the horizon
      ;(surfUniforms.uMouse.value as THREE.Vector2).set(hitX, hitZ)
      surfUniforms.uMouseStr.value = mStr
      moteUniforms.uTime.value = t

      renderer.render(scene, camera)
      if (running) raf = requestAnimationFrame(render)
    }

    // Полная очистка ресурсов three (иначе после contextlost сцена/материалы утекают).
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
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost)
      pointsGeo.dispose()
      pointsMat.dispose()
      linesGeo.dispose()
      linesMat.dispose()
      moteGeo.dispose()
      moteMat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
    }

    function onContextLost(e: Event) {
      e.preventDefault()
      dispose()
      setMode("canvas2d")
    }
    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running && !disposed && mode() === "webgl") {
        running = true
        raf = requestAnimationFrame(render)
      }
    }

    window.addEventListener("mousemove", onMove, { passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    scroller?.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("visibilitychange", onVisibility)
    renderer.domElement.addEventListener("webglcontextlost", onContextLost, false)
    onScroll()
    raf = requestAnimationFrame(render)

    onCleanup(dispose)
  })

  return (
    <div class="isaac-lp-world" aria-hidden="true">
      <Show when={mode() === "webgl"}>
        <div ref={container} class="isaac-lp-world__gl" />
      </Show>
      <Show when={mode() === "canvas2d"}>
        <DotWaveBackground />
      </Show>
      <Show when={mode() === "static"}>
        <div class="isaac-lp-world__static" />
      </Show>
    </div>
  )
}
