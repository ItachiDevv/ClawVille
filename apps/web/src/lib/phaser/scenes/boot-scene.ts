import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'Boot' });
  }

  preload(): void {
    this.load.image('map', '/map/neopia-central-map.png');
  }

  create(): void {
    this.scene.start('Town');
  }
}
