import * as THREE from 'three';
import type { Level } from '../game/level.ts';
import { FLOOR_SIZE } from './dims.ts';

/** "从来没有"：比任何时刻都晚 */
const NEVER = 1e9;
/** 墙在数据里的记号 */
const WALL = 9;

/** 染料是从哪里渗开的：落点正中、横着滚过的那条线、竖着滚过的那条线 */
export type DyeFrom = 0 | 1 | 2;

/**
 * 底板上的染色。
 *
 * 每个格子在一张小小的数据图里占一个点，记四个数：
 *   R 什么时候染上的   G 染料从哪渗开（见 DyeFrom；9 表示这格是墙）
 *   B 小球最后一次滚过是什么时候（刚滚过的地方是湿的、会反光）   A 什么时候开始褪色（撤销时用）
 * 着色器拿"现在几点"和这些时刻比较，自己算出染料渗到哪了、还有多湿，所以不用每帧重画整张图。
 */
export class Stain {
  readonly uniforms: {
    uCells: { value: THREE.DataTexture };
    uGrid: { value: THREE.Vector2 };
    uTime: { value: number };
    uDye: { value: THREE.Color };
    /** 弹珠的球心（托盘自己的坐标）和半径；半径为 0 表示现在没有弹珠 */
    uBall: { value: THREE.Vector4 };
    /** 主光前进的方向 */
    uSun: { value: THREE.Vector3 };
  };
  private readonly data: Float32Array;
  private readonly texture: THREE.DataTexture;
  private readonly level: Level;

  constructor(level: Level, dye: THREE.Color, sun: THREE.Vector3) {
    this.level = level;
    const count = level.rows * level.cols;
    this.data = new Float32Array(count * 4);
    for (let cell = 0; cell < count; cell++) this.blank(cell);
    this.texture = new THREE.DataTexture(this.data, level.cols, level.rows, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.uniforms = {
      uCells: { value: this.texture },
      uGrid: { value: new THREE.Vector2(level.cols, level.rows) },
      uTime: { value: 0 },
      uDye: { value: dye.clone() },
      uBall: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSun: { value: sun.clone() },
    };
  }

  /** 弹珠现在在哪：底板据此画出玻璃球的影子（中间有一块聚出来的亮斑） */
  setBall(x: number, y: number, z: number, radius: number): void {
    this.uniforms.uBall.value.set(x, y, z, radius);
  }

  private blank(cell: number): void {
    const i = cell * 4;
    this.data[i] = NEVER;
    this.data[i + 1] = this.level.floor[cell] ? 0 : WALL;
    this.data[i + 2] = -NEVER;
    this.data[i + 3] = NEVER;
  }

  /** 这一格在 time 时刻染上色 */
  dye(cell: number, time: number, from: DyeFrom): void {
    const i = cell * 4;
    this.data[i] = time;
    this.data[i + 1] = from;
    this.data[i + 2] = time;
    this.data[i + 3] = NEVER;
    this.texture.needsUpdate = true;
  }

  /** 小球在 time 时刻又滚过这一格：重新变湿 */
  wet(cell: number, time: number): void {
    this.data[cell * 4 + 2] = time;
    this.texture.needsUpdate = true;
  }

  /** 这一格的颜色从 time 时刻开始褪掉 */
  fade(cell: number, time: number): void {
    this.data[cell * 4 + 3] = time;
    this.texture.needsUpdate = true;
  }

  /** 这一格现在在画面上是不是染着色（包括正在渗开的） */
  isDyed(cell: number): boolean {
    return this.data[cell * 4] < NEVER && this.data[cell * 4 + 3] >= NEVER;
  }

  dispose(): void {
    this.texture.dispose();
  }

  /** 给底板的材质加上染色效果 */
  patch(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGridUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGridUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${COLOR}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGHNESS}`);
    };
    material.customProgramCacheKey = () => 'stain-v2';
  }
}

const PARS = /* glsl */ `
uniform sampler2D uCells;
uniform vec2 uGrid;
uniform float uTime;
uniform vec3 uDye;
uniform vec4 uBall;
uniform vec3 uSun;
varying vec2 vGridUv;
float stainWet = 0.0;
float stainAmount = 0.0;

float stainHash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float stainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(stainHash(i), stainHash(i + vec2(1.0, 0.0)), f.x),
    mix(stainHash(i + vec2(0.0, 1.0)), stainHash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}
// 棋盘外面一律当成墙
vec4 stainCell(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uGrid.x) || c.y >= int(uGrid.y)) return vec4(1.0e9, 9.0, -1.0e9, 1.0e9);
  return texelFetch(uCells, c, 0);
}
// 这一格此刻有多少颜色：没染是 0，染着是 1，正在褪色的在两者之间
float stainLive(vec4 cell) {
  if (cell.g > 8.5 || cell.r > uTime) return 0.0;
  return 1.0 - smoothstep(0.0, 0.16, uTime - cell.a);
}
// 从相邻的染色格子渗过格线的一点点毛边：edge 是到那条格线的距离
float stainFringe(vec4 nb, float edge, float wobble) {
  float live = stainLive(nb);
  if (live <= 0.0) return 0.0;
  float reach = clamp((uTime - nb.r) * 2.0 - 0.5, 0.0, 1.0) * (0.02 + 0.07 * wobble);
  return (1.0 - smoothstep(reach - 0.02, reach + 0.008, edge)) * step(0.004, reach) * live;
}
`;

const COLOR = /* glsl */ `
{
  vec2 sg = vGridUv * uGrid;
  ivec2 sc = ivec2(floor(sg));
  vec2 sf = fract(sg);
  vec4 me = stainCell(sc);
  vec4 nbL = stainCell(sc + ivec2(-1, 0));
  vec4 nbR = stainCell(sc + ivec2(1, 0));
  vec4 nbU = stainCell(sc + ivec2(0, -1));
  vec4 nbD = stainCell(sc + ivec2(0, 1));
  bool isFloor = me.g < 8.5;
  float wobble = stainNoise(sg * 2.3) * 0.6 + stainNoise(sg * 7.9) * 0.4;

  float amount = 0.0;
  float wetAt = -1.0e9;
  float live = stainLive(me);
  if (live > 0.0) {
    // 染料从小球压过的那条线（或落点）往两边渗，很快铺满整格
    float age = uTime - me.r;
    float dist = me.g < 0.5 ? length(sf - 0.5) * 0.82 : (me.g < 1.5 ? abs(sf.y - 0.5) : abs(sf.x - 0.5));
    float front = 0.17 + age * 2.0;
    amount = (1.0 - smoothstep(front - 0.05, front + 0.02, dist + (wobble - 0.5) * 0.18)) * live;
    wetAt = me.b;
  }
  if (isFloor && amount < 0.999) {
    float f;
    f = stainFringe(nbL, sf.x, wobble);       if (f > amount) { amount = f; wetAt = nbL.b; }
    f = stainFringe(nbR, 1.0 - sf.x, wobble); if (f > amount) { amount = f; wetAt = nbR.b; }
    f = stainFringe(nbU, sf.y, wobble);       if (f > amount) { amount = f; wetAt = nbU.b; }
    f = stainFringe(nbD, 1.0 - sf.y, wobble); if (f > amount) { amount = f; wetAt = nbD.b; }
  }

  // 墙根处照不到那么多光，稍微暗一点
  float shade = 0.0;
  if (nbL.g > 8.5) shade += exp(-sf.x / 0.13);
  if (nbR.g > 8.5) shade += exp(-(1.0 - sf.x) / 0.13);
  if (nbU.g > 8.5) shade += exp(-sf.y / 0.13);
  if (nbD.g > 8.5) shade += exp(-(1.0 - sf.y) / 0.13);
  diffuseColor.rgb *= 1.0 - 0.34 * min(shade, 1.0);

  // 染过的木头：颜色是染料的，深浅仍然跟着木纹走
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float wet = uTime >= wetAt ? exp(-(uTime - wetAt) / 1.5) : 0.0;
  vec3 dyed = uDye * (0.34 + 1.2 * lum) * (1.0 - 0.2 * wet);
  diffuseColor.rgb = mix(diffuseColor.rgb, dyed, amount * 0.94);

  // 格线：激光在底板上划出的细线，染料会积在线里
  if (isFloor) {
    vec2 toEdge = 0.5 - abs(sf - 0.5);
    float e = min(toEdge.x, toEdge.y);
    float aa = fwidth(sg.x) + fwidth(sg.y);
    float line = 1.0 - smoothstep(0.008, 0.008 + aa, e);
    diffuseColor.rgb *= 1.0 - line * mix(0.2, 0.34, amount);
  }

  // 玻璃弹珠的影子：玻璃不挡光而是把光聚拢，所以影子外圈暗、中间反而有一块亮斑
  if (uBall.w > 0.0) {
    vec2 here = (vGridUv - 0.5) * ${FLOOR_SIZE.toFixed(1)};
    vec2 along = normalize(uSun.xz);
    vec2 rel = here - (uBall.xz + uSun.xz * (uBall.y / -uSun.y));
    // 影子顺着光的方向被拉长，这里把它压回成圆再量距离
    float d = length(vec2(dot(rel, along) * -uSun.y, dot(rel, vec2(-along.y, along.x)))) / uBall.w;
    float lift = max(uBall.y / uBall.w - 1.0, 0.0);
    float soft = 0.14 + lift * 0.1;
    float fade = 1.0 / (1.0 + lift * 0.35);
    float shadow = (1.0 - smoothstep(1.0 - soft, 1.0 + soft, d)) * fade;
    // 球离开地面后，聚出来的亮斑很快就散了
    float glow = exp(-pow(d / (0.4 + lift * 0.15), 2.0)) / (1.0 + lift * 2.5);
    diffuseColor.rgb *= 1.0 - 0.5 * shadow;
    diffuseColor.rgb *= 1.0 + 3.2 * glow;
  }

  stainAmount = amount;
  stainWet = amount * wet;
}
`;

const ROUGHNESS = /* glsl */ `
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.82, stainAmount);
roughnessFactor = mix(roughnessFactor, 0.16, stainWet * 0.92);
`;
