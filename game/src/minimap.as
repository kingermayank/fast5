// The minimap inside the HUD's bezel (bottom left): the streets and blocks
// around the convoy, turned so up is the way the camera looks, with the route,
// the crew, the vault and the police on top. Vectors, drawn over the 3D view.
//
// The paths are built in world metres from the streets near the player and
// rebuilt as it moves on; one transform per frame puts them in the bezel.
import { Renderer } from "rive/renderer";
import { Path } from "rive/path";
import { Paint, PaintStyle, StrokeJoin, StrokeCap } from "rive/paint";
import { Vector } from "rive/vector";
import { Mat2D } from "rive/mat2d";
import { MapData } from "./map";

/** Metres from the player to the bezel's edge. */
const RANGE: f64 = 260;
/** Paths cover this far around where they were built, and are rebuilt past half of it. */
const REACH: f64 = 620;

export class Minimap {
  map: MapData;
  builtX: f64 = 1e9;
  builtZ: f64 = 1e9;
  blocks: Path = new Path();
  streets: Path = new Path();
  avenues: Path = new Path();
  route: Path = new Path();
  disc: Path = new Path();
  marker: Path = new Path();
  bg: Paint = new Paint();
  blockPaint: Paint = new Paint();
  streetPaint: Paint = new Paint();
  avenuePaint: Paint = new Paint();
  routePaint: Paint = new Paint();
  routeGlow: Paint = new Paint();
  fill: Paint = new Paint();
  edge: Paint = new Paint();
  /** The GPS route as x z pairs, ahead of the player; set by the game. */
  routePts: Array<f64> = [];

  constructor(map: MapData) {
    this.map = map;
    this.bg.color = 0xd90a0e16;
    this.blockPaint.color = 0x2efff4e3;
    this.streetPaint.style = PaintStyle.stroke;
    this.streetPaint.color = 0x59fff4e3;
    this.streetPaint.join = StrokeJoin.round;
    this.streetPaint.cap = StrokeCap.round;
    this.avenuePaint.style = PaintStyle.stroke;
    this.avenuePaint.color = 0x8cfff4e3;
    this.avenuePaint.join = StrokeJoin.round;
    this.avenuePaint.cap = StrokeCap.round;
    this.routePaint.style = PaintStyle.stroke;
    this.routePaint.color = 0xffffb547;
    this.routePaint.join = StrokeJoin.round;
    this.routePaint.cap = StrokeCap.round;
    this.routeGlow.style = PaintStyle.stroke;
    this.routeGlow.color = 0x66ff9a2e;
    this.routeGlow.join = StrokeJoin.round;
    this.routeGlow.cap = StrokeCap.round;
    this.edge.style = PaintStyle.stroke;
    this.edge.join = StrokeJoin.round;
  }

  /** Rebuilds the street and block paths around (x, z). */
  private build(x: f64, z: f64): void {
    this.builtX = x;
    this.builtZ = z;
    let map = this.map;
    let blocks = this.blocks, streets = this.streets, avenues = this.avenues;
    blocks.reset();
    streets.reset();
    avenues.reset();
    for (let i = 0; i < map.buildings.length; i++) {
      let b = map.buildings[i];
      if (b.maxX < x - REACH || b.minX > x + REACH || b.maxZ < z - REACH || b.minZ > z + REACH) continue;
      let p = b.pts;
      blocks.moveTo(Vector.xy(<f32>p[0], <f32>p[1]));
      for (let k = 2; k < p.length; k += 2) blocks.lineTo(Vector.xy(<f32>p[k], <f32>p[k + 1]));
      blocks.close();
    }
    for (let i = 0; i < map.edges.length; i++) {
      let e = map.edges[i];
      let p = e.pts;
      let near = false;
      for (let k = 0; k < p.length && !near; k += 2) near = Math.abs(p[k] - x) < REACH && Math.abs(p[k + 1] - z) < REACH;
      if (!near) continue;
      let path = e.rank <= 3 ? avenues : streets;
      path.moveTo(Vector.xy(<f32>p[0], <f32>p[1]));
      for (let k = 2; k < p.length; k += 2) path.lineTo(Vector.xy(<f32>p[k], <f32>p[k + 1]));
    }
  }

  /**
   * Draws it centred on (cx, cy) with radius r (points), the player at (px, pz)
   * and the camera looking along `yaw` (forward is sin yaw, cos yaw).
   */
  begin(renderer: Renderer, cx: f64, cy: f64, r: f64, px: f64, pz: f64, yaw: f64): void {
    if (Math.abs(px - this.builtX) > REACH * 0.5 || Math.abs(pz - this.builtZ) > REACH * 0.5) this.build(px, pz);
    let disc = this.disc;
    disc.reset();
    circle(disc, cx, cy, r);
    renderer.save();
    renderer.clipPath(disc);
    renderer.drawPath(disc, this.bg);
    // World metres to bezel points: screen right is the camera's right, up its forward.
    let s = r / RANGE;
    let c = Math.cos(yaw), sn = Math.sin(yaw);
    let xx = -s * c, yx = s * sn, xy = -s * sn, yy = -s * c;
    let tx = cx - (xx * px + yx * pz), ty = cy - (xy * px + yy * pz);
    renderer.save();
    renderer.transform(Mat2D.values(<f32>xx, <f32>xy, <f32>yx, <f32>yy, <f32>tx, <f32>ty));
    renderer.drawPath(this.blocks, this.blockPaint);
    this.streetPaint.thickness = 9;
    renderer.drawPath(this.streets, this.streetPaint);
    this.avenuePaint.thickness = 18;
    renderer.drawPath(this.avenues, this.avenuePaint);
    let pts = this.routePts;
    if (pts.length >= 4) {
      let route = this.route;
      route.reset();
      route.moveTo(Vector.xy(<f32>pts[0], <f32>pts[1]));
      for (let k = 2; k + 1 < pts.length; k += 2) route.lineTo(Vector.xy(<f32>pts[k], <f32>pts[k + 1]));
      this.routeGlow.thickness = <f32>(9 / s);
      renderer.drawPath(route, this.routeGlow);
      this.routePaint.thickness = <f32>(4 / s);
      renderer.drawPath(route, this.routePaint);
    }
    renderer.restore();
    // The markers are drawn by the game between begin and end, through `dot` and `arrow`,
    // which take world positions and keep their size in points.
    this.cx = cx;
    this.cy = cy;
    this.px = px;
    this.pz = pz;
    this.s = s;
    this.c = c;
    this.sn = sn;
  }

  // The frame's transform, for the markers.
  private cx: f64 = 0;
  private cy: f64 = 0;
  private px: f64 = 0;
  private pz: f64 = 0;
  private s: f64 = 1;
  private c: f64 = 1;
  private sn: f64 = 0;

  private u(x: f64, z: f64): f64 {
    return this.cx + this.s * (-(x - this.px) * this.c + (z - this.pz) * this.sn);
  }

  private v(x: f64, z: f64): f64 {
    return this.cy - this.s * ((x - this.px) * this.sn + (z - this.pz) * this.c);
  }

  /** A round blip at a world position. */
  dot(renderer: Renderer, x: f64, z: f64, radius: f64, color: u32, outline: u32): void {
    let m = this.marker;
    m.reset();
    circle(m, this.u(x, z), this.v(x, z), radius);
    this.fill.color = color;
    renderer.drawPath(m, this.fill);
    if (outline != 0) {
      this.edge.color = outline;
      this.edge.thickness = 1.5;
      renderer.drawPath(m, this.edge);
    }
  }

  /** A square blip turned with heading `a` (the vault). */
  box(renderer: Renderer, x: f64, z: f64, half: f64, a: f64, color: u32, outline: u32): void {
    let m = this.marker;
    m.reset();
    let cx = this.u(x, z), cy = this.v(x, z);
    // Heading on the map: the world's forward (sin a, cos a) turned into the bezel.
    let ang = this.screenAngle(a);
    let ca = Math.cos(ang), sa = Math.sin(ang);
    m.moveTo(Vector.xy(<f32>(cx + (-half) * ca - (-half) * sa), <f32>(cy + (-half) * sa + (-half) * ca)));
    m.lineTo(Vector.xy(<f32>(cx + half * ca - (-half) * sa), <f32>(cy + half * sa + (-half) * ca)));
    m.lineTo(Vector.xy(<f32>(cx + half * ca - half * sa), <f32>(cy + half * sa + half * ca)));
    m.lineTo(Vector.xy(<f32>(cx + (-half) * ca - half * sa), <f32>(cy + (-half) * sa + half * ca)));
    m.close();
    this.fill.color = color;
    renderer.drawPath(m, this.fill);
    if (outline != 0) {
      this.edge.color = outline;
      this.edge.thickness = 1.5;
      renderer.drawPath(m, this.edge);
    }
  }

  /** A car: an arrowhead pointing along heading `a`. */
  arrow(renderer: Renderer, x: f64, z: f64, a: f64, size: f64, color: u32, outline: u32): void {
    let m = this.marker;
    m.reset();
    let cx = this.u(x, z), cy = this.v(x, z);
    let ang = this.screenAngle(a);
    let ca = Math.cos(ang), sa = Math.sin(ang);
    // Points of the arrow pointing up (-y), turned by ang.
    m.moveTo(Vector.xy(<f32>(cx + size * sa), <f32>(cy - size * ca)));
    m.lineTo(Vector.xy(<f32>(cx + size * 0.75 * ca - size * 0.8 * sa), <f32>(cy + size * 0.75 * sa + size * 0.8 * ca)));
    m.lineTo(Vector.xy(<f32>(cx - size * 0.3 * sa), <f32>(cy + size * 0.3 * ca)));
    m.lineTo(Vector.xy(<f32>(cx - size * 0.75 * ca - size * 0.8 * sa), <f32>(cy - size * 0.75 * sa + size * 0.8 * ca)));
    m.close();
    this.fill.color = color;
    renderer.drawPath(m, this.fill);
    if (outline != 0) {
      this.edge.color = outline;
      this.edge.thickness = 1.5;
      renderer.drawPath(m, this.edge);
    }
  }

  /** Clockwise screen angle (0 = up) of world heading `a`. */
  screenAngle(a: f64): f64 {
    let fx = Math.sin(a), fz = Math.cos(a);
    let sx = -fx * this.c + fz * this.sn;
    let sy = fx * this.sn + fz * this.c;
    return Math.atan2(sx, sy);
  }

  end(renderer: Renderer): void {
    renderer.restore();
  }
}

/** A circle as four cubic arcs. */
export function circle(p: Path, cx: f64, cy: f64, r: f64): void {
  let k = r * 0.5523;
  p.moveTo(Vector.xy(<f32>(cx + r), <f32>cy));
  p.cubicTo(Vector.xy(<f32>(cx + r), <f32>(cy + k)), Vector.xy(<f32>(cx + k), <f32>(cy + r)), Vector.xy(<f32>cx, <f32>(cy + r)));
  p.cubicTo(Vector.xy(<f32>(cx - k), <f32>(cy + r)), Vector.xy(<f32>(cx - r), <f32>(cy + k)), Vector.xy(<f32>(cx - r), <f32>cy));
  p.cubicTo(Vector.xy(<f32>(cx - r), <f32>(cy - k)), Vector.xy(<f32>(cx - k), <f32>(cy - r)), Vector.xy(<f32>cx, <f32>(cy - r)));
  p.cubicTo(Vector.xy(<f32>(cx + k), <f32>(cy - r)), Vector.xy(<f32>(cx + r), <f32>(cy - k)), Vector.xy(<f32>(cx + r), <f32>cy));
  p.close();
}
