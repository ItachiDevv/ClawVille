import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'Boot' });
  }

  preload(): void {
    this.load.image('map', '/map/clawville-map.png');
  }

  create(): void {
    this.scene.start('Town');
  }
}
