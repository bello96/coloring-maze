// 替身舞台：不碰 WebGL，只记下被调用了多少次。接口和 src/view/stage.ts 里的 Stage 一样。
import * as THREE from 'three';
import type { Insets } from '../../src/view/stage.ts';

export class Stage {
  readonly board = new THREE.Group();
  /** 一共画了多少帧 */
  renders = 0;
  /** 其中有多少帧重画了影子 */
  shadowRenders = 0;
  readonly resizes: Array<{ width: number; height: number; pixelRatio: number; safe: Insets }> = [];
  readonly assets: unknown;

  constructor(_canvas: unknown, font: string) {
    const canvas = (): unknown => document.createElement('canvas');
    this.assets = {
      birch: new THREE.Texture(),
      birchRelief: new THREE.Texture(),
      walnut: canvas(),
      walnutRelief: canvas(),
      plyEdge: new THREE.Texture(),
      anisotropy: 1,
      font,
      sun: new THREE.Vector3(9.5, -12.5, 7.5).normalize(),
    };
  }

  setShadowReach(): void {}

  resize(width: number, height: number, pixelRatio: number, safe: Insets): void {
    this.resizes.push({ width, height, pixelRatio, safe: { ...safe } });
  }

  render(trayMoved: boolean): void {
    this.renders++;
    if (trayMoved) this.shadowRenders++;
  }

  gpuName(): string {
    return '';
  }

  woodUrls(): { dark: string; light: string } {
    return { dark: 'data:,', light: 'data:,' };
  }
}
