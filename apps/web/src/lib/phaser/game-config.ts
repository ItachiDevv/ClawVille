import Phaser from 'phaser';
import { BootScene } from './scenes/boot-scene';
import { TownScene } from './scenes/town-scene';

export function getGameConfig(parentElement: HTMLElement): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    parent: parentElement,
    width: window.innerWidth,
    height: window.innerHeight,
    pixelArt: true,
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, TownScene],
  };
}
